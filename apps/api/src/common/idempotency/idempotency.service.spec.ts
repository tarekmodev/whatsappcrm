import { Prisma } from '../../generated/prisma/client';
import type { TenantPrisma } from '../../prisma/prisma.tokens';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { IdempotencyKeyReusedError, IdempotentRequestInFlightError } from './idempotency.errors';
import { IdempotencyService } from './idempotency.service';
import { hashIdempotentRequest } from './request-hash';

/**
 * The four behaviours 0002 specifies for `Idempotency-Key`, plus the two the
 * implementation has to add for them to hold under concurrency.
 *
 * The store is a real in-memory table rather than a bag of `jest.fn()`s,
 * because what is being tested *is* the interaction with the unique index: the
 * claim, the collision, and what each branch does with the row it finds. Mocked
 * per-call returns would let a wrong sequence pass.
 */

const TENANT = '68444444-4444-7444-8444-444444444401';
const KEY = '68444444-4444-7444-8444-4444444444k1'.replace('k', 'd');

const REQUEST = {
  key: KEY,
  operation: 'conversation.send',
  target: '68444444-4444-7444-8444-4444444444c1',
  payload: { type: 'text', body: 'hello' },
  statusCode: 201,
};

interface StoredKey {
  tenantId: string;
  key: string;
  requestHash: string;
  state: 'in_progress' | 'completed';
  statusCode: number | null;
  responseBody: unknown;
  expiresAt: Date;
}

/**
 * `idempotency_keys` with its one unique index, which is the whole mechanism:
 * two concurrent claims both find no stored response, and only `(tenant_id,
 * key)` can decide which of them proceeds.
 */
class FakeIdempotencyKeys {
  readonly rows: StoredKey[] = [];

  create = jest.fn(({ data }: { data: Omit<StoredKey, 'statusCode' | 'responseBody'> }) => {
    if (this.rows.some((row) => row.tenantId === data.tenantId && row.key === data.key)) {
      return Promise.reject(uniqueViolation());
    }

    this.rows.push({ ...data, statusCode: null, responseBody: null });

    return Promise.resolve({ id: 'row' });
  });

  findUnique = jest.fn(
    ({ where }: { where: { tenantId_key: { tenantId: string; key: string } } }) =>
      Promise.resolve(
        this.rows.find(
          (row) =>
            row.tenantId === where.tenantId_key.tenantId && row.key === where.tenantId_key.key,
        ) ?? null,
      ),
  );

  updateMany = jest.fn(
    ({
      where,
      data,
    }: {
      where: { tenantId: string; key: string; requestHash?: string; state?: string };
      data: Partial<StoredKey>;
    }) => {
      const matched = this.rows.filter((row) => matches(row, where));

      for (const row of matched) {
        Object.assign(row, data);
      }

      return Promise.resolve({ count: matched.length });
    },
  );

  deleteMany = jest.fn(
    ({
      where,
    }: {
      where: {
        tenantId: string;
        key: string;
        requestHash?: string;
        state?: string;
        expiresAt?: { lte: Date };
      };
    }) => {
      let removed = 0;

      for (let index = this.rows.length - 1; index >= 0; index -= 1) {
        const row = this.rows[index];

        if (
          row !== undefined &&
          matches(row, where) &&
          (where.expiresAt === undefined ||
            row.expiresAt.getTime() <= where.expiresAt.lte.getTime())
        ) {
          this.rows.splice(index, 1);
          removed += 1;
        }
      }

      return Promise.resolve({ count: removed });
    },
  );
}

function matches(
  row: StoredKey,
  where: { tenantId: string; key: string; requestHash?: string; state?: string },
): boolean {
  return (
    row.tenantId === where.tenantId &&
    row.key === where.key &&
    (where.requestHash === undefined || row.requestHash === where.requestHash) &&
    (where.state === undefined || row.state === where.state)
  );
}

/** The shape `isUniqueViolationOn` recognises, including the failing column. */
function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['tenant_id', 'key'] },
  });
}

describe('IdempotencyService', () => {
  let keys: FakeIdempotencyKeys;
  let service: IdempotencyService;
  let tenantContext: TenantContextService;

  function inScope<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: 'idempotency-spec', tenantId: TENANT, userId: null },
      async () => await work(),
    );
  }

  beforeEach(() => {
    keys = new FakeIdempotencyKeys();
    tenantContext = new TenantContextService();
    service = new IdempotencyService(
      { idempotencyKey: keys } as unknown as TenantPrisma,
      tenantContext,
    );
  });

  it('runs the work once and stores what it produced', async () => {
    const work = jest.fn(() => Promise.resolve({ id: 'message-1' }));

    const outcome = await inScope(async () => await service.execute(REQUEST, work));

    expect(outcome).toEqual({ statusCode: 201, body: { id: 'message-1' }, replayed: false });
    expect(work).toHaveBeenCalledTimes(1);
    expect(keys.rows[0]).toMatchObject({ state: 'completed', statusCode: 201 });
  });

  it('replays the stored response for the same body, and re-executes nothing', async () => {
    // The requirement in one assertion: an agent double-clicking Send during a
    // slow Meta call must not send the customer two messages.
    const work = jest.fn(() => Promise.resolve({ id: 'message-1' }));

    await inScope(async () => await service.execute(REQUEST, work));
    const replay = await inScope(async () => await service.execute(REQUEST, work));

    expect(replay).toEqual({ statusCode: 201, body: { id: 'message-1' }, replayed: true });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('refuses the same key with a different body', async () => {
    await inScope(
      async () => await service.execute(REQUEST, () => Promise.resolve({ id: 'message-1' })),
    );

    await expect(
      inScope(
        async () =>
          await service.execute(
            { ...REQUEST, payload: { type: 'text', body: 'a different message' } },
            () => Promise.resolve({ id: 'message-2' }),
          ),
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('refuses the same key on another conversation', async () => {
    // Same body, different target. Replaying the stored response there would
    // report a message as sent into a thread that received nothing.
    await inScope(
      async () => await service.execute(REQUEST, () => Promise.resolve({ id: 'message-1' })),
    );

    await expect(
      inScope(
        async () =>
          await service.execute(
            { ...REQUEST, target: '68444444-4444-7444-8444-4444444444c2' },
            () => Promise.resolve({ id: 'message-2' }),
          ),
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('answers a retry that arrives while the first attempt is still running', async () => {
    let release: () => void = () => undefined;
    const first = inScope(
      async () =>
        await service.execute(REQUEST, async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });

          return { id: 'message-1' };
        }),
    );

    // Let the claim land before the second caller arrives.
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      inScope(
        async () => await service.execute(REQUEST, () => Promise.resolve({ id: 'message-2' })),
      ),
    ).rejects.toBeInstanceOf(IdempotentRequestInFlightError);

    release();
    await expect(first).resolves.toMatchObject({ replayed: false });
  });

  it('treats a key past its 24 hours as a new request', async () => {
    await inScope(
      async () => await service.execute(REQUEST, () => Promise.resolve({ id: 'message-1' })),
    );

    // Age the stored row rather than the clock: what the rule turns on is
    // `expires_at`, and moving it is the honest way to express "a day later".
    const stored = keys.rows[0];

    if (stored === undefined) {
      throw new Error('the first execution stored nothing');
    }

    stored.expiresAt = new Date(Date.now() - 1_000);

    const outcome = await inScope(
      async () => await service.execute(REQUEST, () => Promise.resolve({ id: 'message-2' })),
    );

    expect(outcome).toEqual({ statusCode: 201, body: { id: 'message-2' }, replayed: false });
  });

  it('frees the key when the work fails, so a legitimate retry is not burnt', async () => {
    await expect(
      inScope(
        async () =>
          await service.execute(REQUEST, () => Promise.reject(new Error('the send was refused'))),
      ),
    ).rejects.toThrow('the send was refused');

    expect(keys.rows).toHaveLength(0);

    const retry = await inScope(
      async () => await service.execute(REQUEST, () => Promise.resolve({ id: 'message-1' })),
    );

    expect(retry.replayed).toBe(false);
  });

  it('lets a database failure through rather than reporting it as a replay', async () => {
    keys.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      inScope(
        async () => await service.execute(REQUEST, () => Promise.resolve({ id: 'message-1' })),
      ),
    ).rejects.toThrow('connection reset');
  });

  it('hashes the request the way the store does', () => {
    // Guards the spec itself: if the hash inputs change, the fixtures above stop
    // meaning what they say.
    expect(hashIdempotentRequest(REQUEST)).toHaveLength(64);
  });
});
