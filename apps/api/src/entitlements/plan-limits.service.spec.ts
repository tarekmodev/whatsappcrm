import type { Prisma } from '../generated/prisma/client';
import { PlanLimitExceededError } from './entitlements.errors';
import { PlanLimitsService } from './plan-limits.service';
import { UsageCounterService } from './usage-counter.service';
import { UsagePeriodResolver } from './usage-period.resolver';

/**
 * The seat cap's arithmetic and its refusal, against a stubbed transaction
 * client. Isolation across two tenants is RLS's guarantee and is asserted
 * against a real database in `seat-cap.int-spec.ts` — what these pin is the
 * counting rule, which is where the interesting mistakes are.
 */

const TENANT = '0192f00c-0000-7000-8000-0000000000a1';

interface Counts {
  seatCap: number | null | 'no-row';
  members: number;
  pendingInvites: number;
}

/** The `where` clauses each count was issued with, in the order they ran. */
interface Recorded {
  userCounts: Prisma.UserWhereInput[];
  inviteCounts: Prisma.InviteWhereInput[];
  locks: number;
  /** `lock` and `count` in the order they happened, so ordering can be asserted. */
  sequence: ('lock' | 'count')[];
}

/**
 * A transaction client that answers with fixed counts and records what it was
 * asked. Hand-rolled rather than `jest.fn()`, so the recorded `where` clauses
 * keep their Prisma types and an assertion against one is checked rather than
 * `any`.
 */
function clientFor({ seatCap, members, pendingInvites }: Counts): {
  tx: Prisma.TransactionClient;
  recorded: Recorded;
} {
  const recorded: Recorded = { userCounts: [], inviteCounts: [], locks: 0, sequence: [] };

  const tx = {
    tenantEntitlements: {
      // `PlanEntitlementsSchema`'s shape, because that is what the column holds
      // since ADR 0009 Amendment 1 ruling 3 — a fake that answered with a bare
      // `seatCap` would keep passing while the service read `null` from the real
      // column and every cap silently failed open.
      findFirst: () =>
        Promise.resolve(
          seatCap === 'no-row'
            ? null
            : {
                entitlements: {
                  features: [],
                  limits: {
                    seats: seatCap,
                    conversationsPerPeriod: null,
                    whatsappNumbers: null,
                    teams: null,
                    knowledgeDocuments: null,
                  },
                },
              },
        ),
    },
    user: {
      count: ({ where }: { where: Prisma.UserWhereInput }) => {
        recorded.userCounts.push(where);
        recorded.sequence.push('count');
        return Promise.resolve(members);
      },
    },
    invite: {
      count: ({ where }: { where: Prisma.InviteWhereInput }) => {
        recorded.inviteCounts.push(where);
        return Promise.resolve(pendingInvites);
      },
    },
    $executeRaw: () => {
      recorded.locks += 1;
      recorded.sequence.push('lock');
      return Promise.resolve(1);
    },
  };

  return { tx: tx as unknown as Prisma.TransactionClient, recorded };
}

describe('PlanLimitsService.assertSeatAvailable', () => {
  const service = new PlanLimitsService(new UsageCounterService(new UsagePeriodResolver()));

  it('allows a seat while the tenant is under its cap', async () => {
    const { tx } = clientFor({ seatCap: 3, members: 1, pendingInvites: 1 });

    await expect(service.assertSeatAvailable(tx, TENANT)).resolves.toBeUndefined();
  });

  it('refuses the seat that would take the tenant past its cap', async () => {
    const { tx } = clientFor({ seatCap: 3, members: 2, pendingInvites: 1 });

    await expect(service.assertSeatAvailable(tx, TENANT)).rejects.toThrow(PlanLimitExceededError);
  });

  it('reports the cap and the usage, so a console can render "3 of 3"', async () => {
    const { tx } = clientFor({ seatCap: 3, members: 3, pendingInvites: 0 });

    const error = await service.assertSeatAvailable(tx, TENANT).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PlanLimitExceededError);
    expect(error).toMatchObject({ limit: 'seats', cap: 3, used: 3 });
  });

  /**
   * The half of the count a single scan of `users` would miss. An invitation
   * that has been sent and not accepted has already taken the seat; ignoring it
   * would let an admin on a three-seat trial mint any number of invitations and
   * blow past the cap the moment they were all accepted.
   */
  it('counts an outstanding invitation as a seat already taken', async () => {
    const { tx } = clientFor({ seatCap: 2, members: 1, pendingInvites: 1 });

    await expect(service.assertSeatAvailable(tx, TENANT)).rejects.toThrow(PlanLimitExceededError);
  });

  /**
   * `occupiesSeat` in `people.mapper.ts` says a suspended member still holds
   * their seat, so that releasing one on suspension cannot be used to park staff
   * under the cap. This is the query that has to agree with it.
   */
  it('counts active and suspended members, and nothing else', async () => {
    const { tx, recorded } = clientFor({ seatCap: 5, members: 2, pendingInvites: 0 });

    await service.assertSeatAvailable(tx, TENANT);

    expect(recorded.userCounts).toEqual([{ status: { in: ['active', 'suspended'] } }]);
  });

  /** Accepted, revoked and lapsed invitations are all seats the tenant got back. */
  it('counts only live invitations', async () => {
    const { tx, recorded } = clientFor({ seatCap: 5, members: 0, pendingInvites: 0 });

    await service.assertSeatAvailable(tx, TENANT);

    const [where] = recorded.inviteCounts;

    expect(where).toMatchObject({ acceptedAt: null, revokedAt: null });
    // Compared separately because the bound is "now", which no literal can match.
    expect(where?.expiresAt).toEqual({ gt: expect.any(Date) as Date });
  });

  describe('unlimited', () => {
    it('allows the seat when the cap is null', async () => {
      const { tx, recorded } = clientFor({ seatCap: null, members: 99, pendingInvites: 99 });

      await expect(service.assertSeatAvailable(tx, TENANT)).resolves.toBeUndefined();
      // Not merely permitted — not even counted. An unlimited tenant pays
      // nothing for a ceiling it does not have.
      expect(recorded.userCounts).toHaveLength(0);
    });

    /**
     * An operator-provisioned tenant created after TAR-403's backfill has no
     * row. It was never sold a cap, so the open answer is the correct one — see
     * the service's own note on the failure direction.
     */
    it('allows the seat when the tenant has no limits row at all', async () => {
      const { tx } = clientFor({ seatCap: 'no-row', members: 99, pendingInvites: 99 });

      await expect(service.assertSeatAvailable(tx, TENANT)).resolves.toBeUndefined();
    });

    it('takes no advisory lock when there is no cap to protect', async () => {
      const { tx, recorded } = clientFor({ seatCap: null, members: 0, pendingInvites: 0 });

      await service.assertSeatAvailable(tx, TENANT);

      expect(recorded.locks).toBe(0);
    });
  });

  /**
   * The count and the write that follows it have to be one atomic unit, or two
   * invitations landing together both read "2 of 3" and both insert. The lock is
   * transaction-scoped, so the commit or the rollback releases it.
   */
  it('serialises the check on a per-tenant advisory lock before counting', async () => {
    const { tx, recorded } = clientFor({ seatCap: 3, members: 0, pendingInvites: 0 });

    await service.assertSeatAvailable(tx, TENANT);

    // One lock, and it is taken before anything is counted — a count that ran
    // first would be the read half of exactly the race the lock exists to stop.
    expect(recorded.locks).toBe(1);
    expect(recorded.sequence).toEqual(['lock', 'count']);
  });
});
