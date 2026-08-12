import type { AuditEntry } from '../audit/audit.service';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { SessionService } from '../identity/session.service';
import { SessionRevocationService } from './session-revocation.service';

/**
 * Revoking for a set of people at once (TAR-244).
 *
 * `revokeFor` proved its single-user shape long ago; what is new is that a team
 * membership change no longer pays for it per member. Both halves are asserted
 * as *call counts*, because the defect was never a wrong answer — it was the
 * number of round trips one transaction made to produce it.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000d1';
const ALICE = '0192f0ff-0000-7000-8000-00000000d001';
const BOB = '0192f0ff-0000-7000-8000-00000000d002';
const CAROL = '0192f0ff-0000-7000-8000-00000000d003';

const TX = {} as Prisma.TransactionClient;

interface Harness {
  revocation: SessionRevocationService;
  batches: readonly AuditEntry[][];
  revokeCalls: number;
}

function buildHarness(revoked: Map<string, number>): Harness {
  const batches: AuditEntry[][] = [];
  const counters = { revokeCalls: 0 };

  const audit = {
    record: () => Promise.reject(new Error('a batch must not fall back to one row per user')),
    recordMany: (_tx: unknown, entries: readonly AuditEntry[]) => {
      batches.push([...entries]);
      return Promise.resolve();
    },
  } as unknown as AuditService;

  const sessions = {
    revokeAllForUsers: () => {
      counters.revokeCalls += 1;
      return Promise.resolve(revoked);
    },
    purgeCacheForUsers: () => Promise.resolve(),
  } as unknown as SessionService;

  return {
    revocation: new SessionRevocationService(audit, sessions),
    batches,
    get revokeCalls() {
      return counters.revokeCalls;
    },
  };
}

describe('SessionRevocationService.revokeForMany', () => {
  it('revokes once for the whole set and audits it in one insert', async () => {
    const harness = buildHarness(
      new Map([
        [ALICE, 2],
        [BOB, 1],
      ]),
    );

    const total = await harness.revocation.revokeForMany(TX, TENANT, [ALICE, BOB], 'teams_change');

    expect(total).toBe(3);
    expect(harness.revokeCalls).toBe(1);
    expect(harness.batches).toHaveLength(1);
    expect(harness.batches[0]).toEqual([
      {
        action: 'session.revoked',
        targetType: 'user',
        targetId: ALICE,
        metadata: { reason: 'teams_change', sessionsRevoked: 2 },
      },
      {
        action: 'session.revoked',
        targetType: 'user',
        targetId: BOB,
        metadata: { reason: 'teams_change', sessionsRevoked: 1 },
      },
    ]);
  });

  it('writes no audit row for somebody who was signed in nowhere', async () => {
    // Carol is in the set and simply had no live session. A row per no-op would
    // bury the events that matter under the ones that did not happen — the same
    // rule the single-user path applies.
    const harness = buildHarness(new Map([[ALICE, 1]]));

    await harness.revocation.revokeForMany(TX, TENANT, [ALICE, CAROL], 'teams_change');

    expect(harness.batches[0]?.map((entry) => entry.targetId)).toEqual([ALICE]);
  });

  it('writes nothing at all when the set revoked nothing', async () => {
    const harness = buildHarness(new Map());

    await expect(
      harness.revocation.revokeForMany(TX, TENANT, [ALICE, BOB], 'teams_change'),
    ).resolves.toBe(0);
    expect(harness.batches).toEqual([]);
  });
});
