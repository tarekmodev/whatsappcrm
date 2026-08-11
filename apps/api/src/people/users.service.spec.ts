import { permissionsForRole, type SessionPrincipal, type TenantRole } from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { SessionRevocationService } from '../rbac/session-revocation.service';
import {
  LastAdminRequiredError,
  RoleAssignmentNotPermittedError,
  RoleEscalationError,
  SelfRoleChangeError,
  UserNotFoundError,
} from './people.errors';
import { UsersService } from './users.service';

/**
 * The four invariants of TAR-79's delta 3, and the role-assignment split of
 * delta 1, against a fake transaction.
 *
 * Fake rather than mocked-out-of-existence: the service's real transaction
 * body runs, including the order the checks happen in — which is the part that
 * matters. What is faked is the database's answers, so a test can put the
 * tenant in the exact state ("one active admin, and you are them") that is
 * awkward to reach and easy to get wrong.
 *
 * The locking half of invariant 3 — that two concurrent demotions cannot both
 * see a survivor — is not testable here and is covered against real Postgres in
 * `people-rbac.int-spec.ts`.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000b1';
const CALLER = '0192f0ff-0000-7000-8000-00000000a001';
const TARGET = '0192f0ff-0000-7000-8000-00000000a002';
const TEAM = '0192f0ff-0000-7000-8000-00000000b001';

function principalFor(role: TenantRole): SessionPrincipal {
  return {
    userId: CALLER,
    tenantId: TENANT,
    email: `${role}@example.invalid`,
    displayName: role,
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: '0192f0ff-0000-7000-8000-0000000000ff',
    expiresAt: '2026-12-31T23:59:59.000Z',
  };
}

interface FakeState {
  /** The target of the write, or `null` to make it look absent. */
  target: { id: string; role: TenantRole; status: string; name: string; email: string } | null;
  /** What the locking read of active admins returns. */
  activeAdminIds: readonly string[];
  teams: readonly string[];
  memberships: readonly string[];
}

interface Recorded {
  audits: { action: string; metadata?: unknown }[];
  revokedUserIds: string[];
  /** The after-commit cache purge (TAR-56), which is unconditional by design. */
  purgedUserIds: string[];
  updates: Record<string, unknown>[];
}

function buildService(state: FakeState): {
  users: UsersService;
  recorded: Recorded;
  tenantContext: TenantContextService;
} {
  const recorded: Recorded = { audits: [], revokedUserIds: [], purgedUserIds: [], updates: [] };

  const row = {
    id: TARGET,
    email: 'target@example.invalid',
    name: 'Target',
    avatarUrl: null,
    role: state.target?.role ?? 'agent',
    status: state.target?.status ?? 'active',
    availability: 'offline',
    lastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    teamMemberships: state.memberships.map((teamId) => ({ teamId })),
  };

  const tx = {
    user: {
      findUnique: () => Promise.resolve(state.target),
      findFirst: () => Promise.resolve(null),
      update: ({ data }: { data: Record<string, unknown> }) => {
        recorded.updates.push(data);
        return Promise.resolve({ ...row, ...data });
      },
      create: () => Promise.resolve({ id: TARGET }),
      findMany: () => Promise.resolve(state.teams.map((id) => ({ id }))),
    },
    team: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.filter((id) => state.teams.includes(id)).map((id) => ({ id }))),
    },
    teamMember: {
      findMany: () => Promise.resolve(state.memberships.map((teamId) => ({ teamId }))),
      deleteMany: () => Promise.resolve({ count: 0 }),
      createMany: () => Promise.resolve({ count: 0 }),
    },
    invite: {
      findFirst: () => Promise.resolve(null),
      create: () =>
        Promise.resolve({
          id: '0192f0ff-0000-7000-8000-00000000c001',
          email: 'invitee@example.invalid',
          role: 'agent',
          invitedByUserId: CALLER,
          expiresAt: new Date('2026-12-31T23:59:59.000Z'),
          acceptedAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
    },
    session: { deleteMany: () => Promise.resolve({ count: 1 }) },
    auditLog: { create: () => Promise.resolve({}) },
    $queryRaw: () => Promise.resolve(state.activeAdminIds.map((id) => ({ id }))),
  };

  const prisma = {
    $tenantTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as TenantPrisma;

  const tenantContext = new TenantContextService();

  const audit = {
    record: (_tx: unknown, entry: { action: string; metadata?: unknown }) => {
      recorded.audits.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditService;

  const sessions = {
    revokeFor: (_tx: unknown, _tenantId: string, userId: string) => {
      recorded.revokedUserIds.push(userId);
      return Promise.resolve(1);
    },
    purgeCacheFor: (_tenantId: string, userId: string) => {
      recorded.purgedUserIds.push(userId);
      return Promise.resolve();
    },
  } as unknown as SessionRevocationService;

  return {
    users: new UsersService(prisma, tenantContext, audit, sessions),
    recorded,
    tenantContext,
  };
}

function asPrincipal<T>(
  tenantContext: TenantContextService,
  role: TenantRole,
  work: () => Promise<T>,
): Promise<T> {
  return tenantContext.run(
    { requestId: 'req_users_spec', tenantId: null, userId: null, principal: null },
    async () => {
      tenantContext.setPrincipal(principalFor(role));
      return work();
    },
  );
}

const activeAgent = {
  id: TARGET,
  role: 'agent' as TenantRole,
  status: 'active',
  name: 'Target',
  email: 'target@example.invalid',
};
const activeAdmin = { ...activeAgent, role: 'admin' as TenantRole };

describe('UsersService — role write invariants', () => {
  describe('invariant 1: nobody changes their own role', () => {
    it('refuses an admin demoting themselves', async () => {
      const { users, tenantContext } = buildService({
        target: activeAdmin,
        activeAdminIds: [CALLER, TARGET],
        teams: [],
        memberships: [],
      });

      await expect(
        asPrincipal(tenantContext, 'admin', () =>
          // The caller's own id, not the target's.
          users.update(CALLER, { role: 'agent' }),
        ),
      ).rejects.toBeInstanceOf(SelfRoleChangeError);
    });

    it('still lets them change their own name', async () => {
      const { users, tenantContext, recorded } = buildService({
        target: { ...activeAdmin, id: CALLER },
        activeAdminIds: [CALLER],
        teams: [],
        memberships: [],
      });

      await asPrincipal(tenantContext, 'admin', () =>
        users.update(CALLER, { displayName: 'New Name' }),
      );

      expect(recorded.updates).toEqual([{ name: 'New Name' }]);
    });
  });

  describe('delta 1: role assignment is separate from user administration', () => {
    it('refuses a supervisor changing anybody’s role', async () => {
      const { users, tenantContext } = buildService({
        target: activeAgent,
        activeAdminIds: [CALLER],
        teams: [],
        memberships: [],
      });

      await expect(
        asPrincipal(tenantContext, 'supervisor', () =>
          users.update(TARGET, { role: 'supervisor' }),
        ),
      ).rejects.toBeInstanceOf(RoleAssignmentNotPermittedError);
    });

    it('lets a supervisor suspend and rename the same person', async () => {
      const { users, tenantContext, recorded } = buildService({
        target: activeAgent,
        activeAdminIds: [CALLER],
        teams: [],
        memberships: [],
      });

      await asPrincipal(tenantContext, 'supervisor', () =>
        users.update(TARGET, { status: 'suspended', displayName: 'Departing Contractor' }),
      );

      expect(recorded.updates).toEqual([{ name: 'Departing Contractor', status: 'suspended' }]);
      expect(recorded.audits.map((entry) => entry.action)).toContain('user.status_changed');
    });

    it('refuses a supervisor inviting anybody above an agent', async () => {
      const { users, tenantContext } = buildService({
        target: null,
        activeAdminIds: [CALLER],
        teams: [],
        memberships: [],
      });

      for (const role of ['supervisor', 'admin'] as const) {
        await expect(
          asPrincipal(tenantContext, 'supervisor', () =>
            users.invite({ email: 'new@example.invalid', role, teamIds: [] }),
          ),
        ).rejects.toBeInstanceOf(RoleAssignmentNotPermittedError);
      }
    });

    it('lets a supervisor invite an agent', async () => {
      const { users, tenantContext, recorded } = buildService({
        target: null,
        activeAdminIds: [CALLER],
        teams: [],
        memberships: [],
      });

      const invite = await asPrincipal(tenantContext, 'supervisor', () =>
        users.invite({ email: 'new@example.invalid', role: 'agent', teamIds: [] }),
      );

      expect(invite.role).toBe('agent');
      expect(recorded.audits.map((entry) => entry.action)).toEqual(['user.invited']);
    });
  });

  describe('invariant 3: the last active admin is protected', () => {
    it('refuses to demote them', async () => {
      const { users, tenantContext } = buildService({
        target: activeAdmin,
        // The target is the only active admin; the caller is somebody else.
        activeAdminIds: [TARGET],
        teams: [],
        memberships: [],
      });

      await expect(
        asPrincipal(tenantContext, 'admin', () => users.update(TARGET, { role: 'supervisor' })),
      ).rejects.toBeInstanceOf(LastAdminRequiredError);
    });

    it('refuses to suspend them', async () => {
      const { users, tenantContext } = buildService({
        target: activeAdmin,
        activeAdminIds: [TARGET],
        teams: [],
        memberships: [],
      });

      await expect(
        asPrincipal(tenantContext, 'admin', () => users.update(TARGET, { status: 'suspended' })),
      ).rejects.toBeInstanceOf(LastAdminRequiredError);
    });

    it('refuses to remove them', async () => {
      const { users, tenantContext } = buildService({
        target: activeAdmin,
        activeAdminIds: [TARGET],
        teams: [],
        memberships: [],
      });

      await expect(
        asPrincipal(tenantContext, 'admin', () => users.remove(TARGET)),
      ).rejects.toBeInstanceOf(LastAdminRequiredError);
    });

    it('allows the demotion once a second admin exists', async () => {
      const { users, tenantContext, recorded } = buildService({
        target: activeAdmin,
        activeAdminIds: [TARGET, CALLER],
        teams: [],
        memberships: [],
      });

      await asPrincipal(tenantContext, 'admin', () => users.update(TARGET, { role: 'supervisor' }));

      expect(recorded.updates).toEqual([{ role: 'supervisor' }]);
    });

    it('does not fire for a change that keeps them an active admin', async () => {
      const { users, tenantContext } = buildService({
        target: activeAdmin,
        activeAdminIds: [TARGET],
        teams: [TEAM],
        memberships: [],
      });

      await expect(
        asPrincipal(tenantContext, 'admin', () => users.update(TARGET, { teamIds: [TEAM] })),
      ).resolves.toBeDefined();
    });
  });

  describe('a role, status or team change logs the user out', () => {
    it.each([
      ['role', { role: 'supervisor' as const }, 'user.role_changed'],
      ['status', { status: 'suspended' as const }, 'user.status_changed'],
    ])('revokes sessions and audits a %s change', async (_label, input, expectedAudit) => {
      const { users, tenantContext, recorded } = buildService({
        target: activeAgent,
        activeAdminIds: [CALLER],
        teams: [],
        memberships: [],
      });

      await asPrincipal(tenantContext, 'admin', () => users.update(TARGET, input));

      expect(recorded.revokedUserIds).toEqual([TARGET]);
      expect(recorded.audits.map((entry) => entry.action)).toContain(expectedAudit);
      // The after-commit purge (TAR-56). Without it a principal cached in the
      // window between the pre-write purge and the commit would keep answering
      // for up to a minute — which is the whole gap "revoked immediately, not
      // on next expiry" exists to close.
      expect(recorded.purgedUserIds).toEqual([TARGET]);
    });

    it('revokes on a team change, because teamIds is a snapshot on the session', async () => {
      const { users, tenantContext, recorded } = buildService({
        target: activeAgent,
        activeAdminIds: [CALLER],
        teams: [TEAM],
        memberships: [],
      });

      await asPrincipal(tenantContext, 'admin', () => users.update(TARGET, { teamIds: [TEAM] }));

      expect(recorded.revokedUserIds).toEqual([TARGET]);
      expect(recorded.audits.map((entry) => entry.action)).toContain('user.teams_changed');
    });

    it('leaves an unchanged session alone when nothing that matters moved', async () => {
      const { users, tenantContext, recorded } = buildService({
        target: activeAgent,
        activeAdminIds: [CALLER],
        teams: [],
        memberships: [],
      });

      await asPrincipal(tenantContext, 'admin', () =>
        users.update(TARGET, { displayName: 'Renamed' }),
      );

      expect(recorded.revokedUserIds).toEqual([]);
      // Purged anyway. It is unconditional on purpose: a purge that was not
      // needed costs one Postgres read, while deciding per write which changes
      // "matter" is a decision that eventually gets one case wrong.
      expect(recorded.purgedUserIds).toEqual([TARGET]);
    });
  });

  describe('cross-tenant reads are indistinguishable from absent ones', () => {
    it('reports not-found rather than forbidden for a user RLS hid', async () => {
      const { users, tenantContext } = buildService({
        target: null,
        activeAdminIds: [CALLER],
        teams: [],
        memberships: [],
      });

      await expect(
        asPrincipal(tenantContext, 'admin', () => users.update(TARGET, { displayName: 'x' })),
      ).rejects.toBeInstanceOf(UserNotFoundError);
    });
  });

  describe('invariant 2: nobody grants a role above their own', () => {
    it('refuses even a holder of user:set_role who is not senior enough', async () => {
      // Not reachable under today's table — only admin holds `user:set_role`,
      // and admin is the top of the order. Asserted anyway, because adding a
      // fourth role between supervisor and admin must not silently open a path.
      const { users, tenantContext } = buildService({
        target: activeAgent,
        activeAdminIds: [CALLER],
        teams: [],
        memberships: [],
      });

      await tenantContext.run(
        { requestId: 'req_escalation', tenantId: null, userId: null, principal: null },
        async () => {
          tenantContext.setPrincipal({
            ...principalFor('supervisor'),
            permissions: [...permissionsForRole('supervisor'), 'user:set_role'],
          });

          await expect(users.update(TARGET, { role: 'admin' })).rejects.toBeInstanceOf(
            RoleEscalationError,
          );
        },
      );
    });
  });
});
