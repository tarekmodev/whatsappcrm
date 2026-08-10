import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * The regression fixture for TAR-92, against a real PostgreSQL.
 *
 * `conversations.last_message_at` leads the inbox's keyset index
 * `(tenant_id, status, last_message_at DESC, id DESC)`. While the column was
 * nullable, a conversation with no message yet wrote NULL there and broke
 * pagination in a way nothing reported: `NULL <= $1` is NULL rather than TRUE,
 * so the resume predicate ruled in
 * docs/architecture/0002-architecture-and-api-contract.md was unknown for that
 * row, and the page came back short. No error, no log line — a conversation
 * simply stopped appearing.
 *
 * A schema assertion alone would not catch a regression here. Someone could
 * make the column nullable again and every unit test would still pass; what
 * fails is paging, several pages in, only when a message-less conversation
 * exists. So this test pages the real predicate over real rows to exhaustion
 * and asserts that every conversation is reachable.
 *
 * It queries through `TenantPrisma` rather than an HTTP route on purpose: the
 * inbox endpoint is TAR-68's, does not exist yet, and this guarantee belongs to
 * the column regardless of who reads it. When TAR-68 lands, its list handler
 * should build the same `where`; if the two ever drift, this file is the one
 * that states what the column promises.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. One fixture
 * tenant and everything under it, every row carrying a fixed id and a
 * `tar92-fixture` marker, deleted before the run as well as after it so an
 * interrupted run cleans up on the next one. Point `pnpm test:db` at a local or
 * disposable database.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '92444444-4444-7444-8444-444444444401';
const WABA = '92444444-4444-7444-8444-4444444444b0';
const WHATSAPP_ACCOUNT = '92444444-4444-7444-8444-4444444444a0';

/**
 * Ids are the tie-breaker, so they are fixed rather than generated: the
 * expected page order below is only meaningful if the ordering of the two rows
 * sharing a timestamp is deterministic.
 */
const CONTACT_IDS = [
  '92444444-4444-7444-8444-4444444444c1',
  '92444444-4444-7444-8444-4444444444c2',
  '92444444-4444-7444-8444-4444444444c3',
  '92444444-4444-7444-8444-4444444444c4',
  // Reserved: one thread per contact per number is unique, so the rejected
  // insert below needs a contact that has no conversation, or it fails on the
  // unique constraint before the column is ever checked.
  '92444444-4444-7444-8444-4444444444c5',
] as const;

/** Conversations in the fixture. The fifth contact deliberately has none. */
const CONVERSATION_COUNT = 4;

const OLDEST = '92444444-4444-7444-8444-4444444444e1';
const TIED_LOW = '92444444-4444-7444-8444-4444444444e2';
const TIED_HIGH = '92444444-4444-7444-8444-4444444444e3';
const SILENT = '92444444-4444-7444-8444-4444444444e4';

/** Fixed, so the tie group is a tie and not a race. */
const TIED_AT = new Date('2026-08-01T10:00:00.000Z');
const OLDEST_AT = new Date('2026-08-01T09:00:00.000Z');

const REQUEST_ID = 'tar92-int-spec';

/** One conversation per page, which is what makes a dropped row impossible to hide. */
const PAGE_SIZE = 1;

type Cursor = { lastMessageAt: Date; id: string };

describe('conversations keyset pagination, end to end', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  function asTenant<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId: TENANT, userId: null },
      async () => await work(),
    );
  }

  /**
   * One page of the inbox, exactly as 0002 rules the resume predicate for a
   * `(last_message_at DESC, id DESC)` sort:
   *
   *   last_message_at <= $1 AND NOT (last_message_at = $1 AND id >= $2)
   *
   * An inclusive bound on the leading column — which a btree index leading with
   * it serves as a start condition — minus the part of the cursor's tie group
   * already returned. Not the nested-OR form, which returns the same rows and
   * loses the index start condition.
   */
  function page(cursor: Cursor | null) {
    return tenantPrisma.conversation.findMany({
      where: {
        status: 'open',
        ...(cursor
          ? {
              lastMessageAt: { lte: cursor.lastMessageAt },
              NOT: { lastMessageAt: cursor.lastMessageAt, id: { gte: cursor.id } },
            }
          : {}),
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE,
      select: { id: true, lastMessageAt: true, createdAt: true },
    });
  }

  /**
   * Pages from the top to exhaustion and returns every id seen, in order.
   *
   * The bound is a guard against a predicate that never advances, not a page
   * limit: without it a broken cursor loops forever and the failure reads as a
   * hung suite rather than a wrong answer.
   */
  async function pageToExhaustion(): Promise<string[]> {
    const seen: string[] = [];
    let cursor: Cursor | null = null;

    for (let request = 0; request <= CONVERSATION_COUNT + 1; request += 1) {
      const rows: Awaited<ReturnType<typeof page>> = await asTenant(() => page(cursor));
      const last = rows.at(-1);

      if (last === undefined) {
        return seen;
      }

      for (const row of rows) {
        seen.push(row.id);
      }

      cursor = { lastMessageAt: last.lastMessageAt, id: last.id };
    }

    throw new Error(`Cursor never exhausted after ${seen.length} rows: ${seen.join(', ')}`);
  }

  async function removeFixture(): Promise<void> {
    // conversations, whatsapp_accounts and contacts all cascade from the tenant.
    await systemPrisma.tenant.deleteMany({ where: { id: TENANT } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    await systemPrisma.tenant.create({
      data: { id: TENANT, slug: 'tar92-fixture', name: 'TAR-92 fixture', status: 'active' },
    });
    await systemPrisma.whatsappBusinessAccount.create({
      data: { id: WABA, tenantId: TENANT, wabaId: 'tar92-fixture-waba' },
    });
    await systemPrisma.whatsappAccount.create({
      data: {
        id: WHATSAPP_ACCOUNT,
        tenantId: TENANT,
        whatsappBusinessAccountId: WABA,
        phoneNumberId: 'tar92-fixture-number',
        displayPhoneNumber: '+10000009200',
      },
    });
    await systemPrisma.contact.createMany({
      data: CONTACT_IDS.map((id, index) => ({
        id,
        tenantId: TENANT,
        phoneE164: `+1000000920${index + 1}`,
        displayName: `tar92-fixture contact ${index + 1}`,
      })),
    });

    const base = {
      tenantId: TENANT,
      whatsappAccountId: WHATSAPP_ACCOUNT,
      status: 'open' as const,
    };

    await systemPrisma.conversation.createMany({
      data: [
        { ...base, id: OLDEST, contactId: CONTACT_IDS[0], lastMessageAt: OLDEST_AT },
        { ...base, id: TIED_LOW, contactId: CONTACT_IDS[1], lastMessageAt: TIED_AT },
        { ...base, id: TIED_HIGH, contactId: CONTACT_IDS[2], lastMessageAt: TIED_AT },
      ],
    });

    // The row this whole test exists for: a conversation opened but never
    // written to.
    //
    // Written in raw SQL, omitting the column entirely, because that is the
    // only way to let the *database* decide its value. Prisma resolves
    // `@default(now())` in the client and would supply a timestamp itself, so a
    // `conversation.create()` here would pass against a nullable column too —
    // the fixture would sit green over exactly the defect it exists to catch.
    // The webhook ingest path is not the only writer this table will ever have.
    await systemPrisma.$executeRaw`
      INSERT INTO conversations (id, tenant_id, whatsapp_account_id, contact_id, status, updated_at)
      VALUES (${SILENT}::uuid, ${TENANT}::uuid, ${WHATSAPP_ACCOUNT}::uuid, ${CONTACT_IDS[3]}::uuid, 'open', CURRENT_TIMESTAMP)
    `;
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  it('gives a message-less conversation a non-null last_message_at', async () => {
    const silent = await systemPrisma.conversation.findUniqueOrThrow({
      where: { id: SILENT },
      select: { lastMessageAt: true, createdAt: true },
    });

    expect(silent.lastMessageAt).not.toBeNull();
    // Both columns default to CURRENT_TIMESTAMP, which in Postgres is the
    // transaction's start time — the same instant for both, to the millisecond.
    expect(silent.lastMessageAt).toEqual(silent.createdAt);
  });

  it('reaches every conversation when paging one row at a time', async () => {
    const seen = await pageToExhaustion();

    // The message-less conversation sorts first: its last_message_at is its own
    // insert time, which is later than either fixture timestamp. That it sorts
    // first is not the point — that nothing after it is lost is.
    expect(seen).toEqual([SILENT, TIED_HIGH, TIED_LOW, OLDEST]);
  });

  it('returns each conversation exactly once', async () => {
    const seen = await pageToExhaustion();

    expect(new Set(seen).size).toBe(seen.length);
  });

  it('does not lose either row of a tie group across the page boundary', async () => {
    // The `NOT (last_message_at = $1 AND id >= $2)` half of the predicate. Two
    // conversations share TIED_AT to the millisecond, and the cursor lands
    // between them; the naive `(last_message_at, id) < ($1, $2)` form drops the
    // second one silently.
    const seen = await pageToExhaustion();

    expect(seen).toContain(TIED_HIGH);
    expect(seen).toContain(TIED_LOW);
    expect(seen.indexOf(TIED_HIGH)).toBeLessThan(seen.indexOf(TIED_LOW));
  });

  it('refuses to write a conversation with a null last_message_at', async () => {
    // The constraint itself, stated once. If this passes while the paging test
    // fails, the bug is in the predicate; if this fails, the migration was
    // reverted.
    await expect(
      systemPrisma.$executeRaw`
        INSERT INTO conversations (id, tenant_id, whatsapp_account_id, contact_id, last_message_at, updated_at)
        VALUES (gen_random_uuid(), ${TENANT}::uuid, ${WHATSAPP_ACCOUNT}::uuid, ${CONTACT_IDS[4]}::uuid, NULL, CURRENT_TIMESTAMP)
      `,
    ).rejects.toThrow(/null value in column "last_message_at"/);
  });
});

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
