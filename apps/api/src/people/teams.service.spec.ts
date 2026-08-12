import {
  TEAM_MEMBERSHIP_LIMITS,
  TeamCreateInputSchema,
  type TeamCreateInput,
  type TeamUpdateInput,
} from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { SessionRevocationService } from '../rbac/session-revocation.service';
import { TeamsService } from './teams.service';

/**
 * A membership change logs the affected people out — both halves of it.
 *
 * `revokeFor` runs inside the transaction and `purgeCacheFor` runs after it
 * commits, and the second one is what closes the window where a concurrent
 * request repopulates the principal cache from the row that is about to be
 * revoked. `UsersService` has always done both; `TeamsService` did only the
 * first, which left a removed member reading the team's conversations for up to
 * `sessionCacheTtlMs` after the commit.
 *
 * Fake transaction rather than mocks, matching `users.service.spec.ts`: the real
 * service body runs, including the order the two calls happen in.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000b1';
const TEAM = '0192f0ff-0000-7000-8000-00000000b001';
const ALICE = '0192f0ff-0000-7000-8000-00000000a001';
const BOB = '0192f0ff-0000-7000-8000-00000000a002';

interface Recorded {
  /** Revoked inside the transaction. */
  revokedUserIds: string[];
  /** Purged after it committed — the half that was missing. */
  purgedUserIds: string[];
  /** Every call in order, so the test can assert the purge came last. */
  order: string[];
  /**
   * How many *calls* each half took, as opposed to how many users they covered.
   * The whole point of TAR-244 is that this stays at one however large the team
   * is.
   */
  calls: { revoke: number; purge: number };
}

function buildService(members: readonly string[]): {
  teams: TeamsService;
  recorded: Recorded;
  tenantContext: TenantContextService;
} {
  const recorded: Recorded = {
    revokedUserIds: [],
    purgedUserIds: [],
    order: [],
    calls: { revoke: 0, purge: 0 },
  };

  const teamRow = {
    id: TEAM,
    name: 'Billing',
    description: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    members: members.map((userId) => ({ userId })),
  };

  const tx = {
    team: {
      create: () => Promise.resolve({ id: TEAM }),
      update: () => Promise.resolve(teamRow),
      findUnique: () => Promise.resolve(teamRow),
      findUniqueOrThrow: () => Promise.resolve(teamRow),
    },
    teamMember: {
      createMany: () => Promise.resolve({ count: 0 }),
      deleteMany: () => Promise.resolve({ count: 0 }),
    },
    user: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id }))),
    },
    auditLog: { create: () => Promise.resolve({}) },
  };

  const prisma = {
    $tenantTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as TenantPrisma;

  const audit = { record: () => Promise.resolve() } as unknown as AuditService;

  const sessions = {
    revokeForMany: (_tx: unknown, _tenantId: string, userIds: readonly string[]) => {
      recorded.calls.revoke += 1;
      recorded.revokedUserIds.push(...userIds);
      recorded.order.push(...userIds.map((userId) => `revoke:${userId}`));
      return Promise.resolve(userIds.length);
    },
    purgeCacheForMany: (_tenantId: string, userIds: readonly string[]) => {
      recorded.calls.purge += 1;
      recorded.purgedUserIds.push(...userIds);
      recorded.order.push(...userIds.map((userId) => `purge:${userId}`));
      return Promise.resolve();
    },
  } as unknown as SessionRevocationService;

  const tenantContext = new TenantContextService();

  return {
    teams: new TeamsService(prisma, tenantContext, audit, sessions),
    recorded,
    tenantContext,
  };
}

function inTenant<T>(tenantContext: TenantContextService, work: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { requestId: 'req_teams_spec', tenantId: TENANT, userId: null, principal: null },
    work,
  );
}

describe('TeamsService — a membership change ends the affected sessions', () => {
  it('purges the principal cache after the commit when a member is added at creation', async () => {
    const { teams, recorded, tenantContext } = buildService([ALICE]);
    const input: TeamCreateInput = { name: 'Billing', description: null, memberUserIds: [ALICE] };

    await inTenant(tenantContext, () => teams.create(input));

    expect(recorded.revokedUserIds).toEqual([ALICE]);
    expect(recorded.purgedUserIds).toEqual([ALICE]);
    // Order matters: purging before the commit only clears what was cached
    // before the write.
    expect(recorded.order).toEqual([`revoke:${ALICE}`, `purge:${ALICE}`]);
  });

  it('purges for both the added and the removed member on an update', async () => {
    // Alice holds the team, Bob replaces her: she loses the scope, he gains it.
    const { teams, recorded, tenantContext } = buildService([ALICE]);
    const input: TeamUpdateInput = { memberUserIds: [BOB] };

    await inTenant(tenantContext, () => teams.update(TEAM, input));

    expect(recorded.revokedUserIds.sort()).toEqual([ALICE, BOB].sort());
    expect(recorded.purgedUserIds.sort()).toEqual([ALICE, BOB].sort());
    expect(recorded.order.slice(-2).every((entry) => entry.startsWith('purge:'))).toBe(true);
  });

  it('leaves sessions alone when the update does not touch membership', async () => {
    const { teams, recorded, tenantContext } = buildService([ALICE]);

    await inTenant(tenantContext, () => teams.update(TEAM, { name: 'Billing EMEA' }));

    expect(recorded.revokedUserIds).toEqual([]);
    // Unlike `UsersService.update`, which purges unconditionally for its single
    // target, there is no user to purge here: `memberUserIds` was omitted, so
    // nobody's `teamIds` moved.
    expect(recorded.purgedUserIds).toEqual([]);
  });
});

/**
 * TAR-244. The finding was a supervisor `POST /teams` with a membership nobody
 * would ever type by hand: validation let it through, and the service then
 * walked it one revocation at a time inside the transaction, holding a pooled
 * connection for a round trip per member — and repeated the shape as one Redis
 * call per member afterwards.
 *
 * Two fixes, tested separately because they fail separately: the contract caps
 * the payload, and the service does the work in one call regardless of size.
 */
describe('TeamsService — a large membership is bounded, and handled in one pass', () => {
  const members = Array.from(
    { length: TEAM_MEMBERSHIP_LIMITS.membersPerTeam },
    (_, index) => `0192f0ff-0000-7000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
  );

  it('refuses a membership larger than the published ceiling at the edge', () => {
    const oversized = [...members, '0192f0ff-0000-7000-8000-0000000fffff'];

    expect(() =>
      TeamCreateInputSchema.parse({ name: 'Billing', memberUserIds: oversized }),
    ).toThrow();
    // …and accepts exactly the ceiling, so the bound is a limit rather than an
    // off-by-one that quietly moved the real one.
    expect(
      TeamCreateInputSchema.parse({ name: 'Billing', memberUserIds: members }).memberUserIds,
    ).toHaveLength(TEAM_MEMBERSHIP_LIMITS.membersPerTeam);
  });

  it('revokes and purges a full team in one call each, not one per member', async () => {
    const { teams, recorded, tenantContext } = buildService(members);
    const input: TeamCreateInput = { name: 'Billing', description: null, memberUserIds: members };

    await inTenant(tenantContext, () => teams.create(input));

    // Everybody is still logged out and still purged — the fan-out moved into
    // one statement, it did not disappear.
    expect(recorded.revokedUserIds).toEqual(members);
    expect(recorded.purgedUserIds).toEqual(members);
    // The property that matters: cost is independent of the team's size.
    expect(recorded.calls).toEqual({ revoke: 1, purge: 1 });
  });
});
