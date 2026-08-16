import { permissionsForRole, type SessionPrincipal, type TenantRole } from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { LoginThrottleService } from '../identity/login-throttle.service';
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
  /** TAR-59's lockout state on the target, as the columns hold it. */
  lockout?: { lockedUntil: Date | null; failedLoginAttempts: number };
}

interface Recorded {
  audits: { action: string; metadata?: unknown }[];
  revokedUserIds: string[];
  /** The after-commit cache purge (TAR-56), which is unconditional by design. */
  purgedUserIds: string[];
  updates: Record<string, unknown>[];
  /** `where` clauses passed to `invite.updateMany` — the withdrawal on removal. */
  inviteWithdrawals: Record<string, unknown>[];
  /** Users whose lockout `UsersService` asked `LoginThrottleService` to clear. */
  unlockedUserIds: string[];
  /** The Redis half of the same unlock, keyed by the address rather than the row. */
  clearedEmailLocks: { tenantId: string; email: string }[];
}

function buildService(state: FakeState): {
  users: UsersService;
  recorded: Recorded;
  tenantContext: TenantContextService;
} {
  const recorded: Recorded = {
    audits: [],
    revokedUserIds: [],
    purgedUserIds: [],
    updates: [],
    inviteWithdrawals: [],
    unlockedUserIds: [],
    clearedEmailLocks: [],
  };

  const lockout = state.lockout ?? { lockedUntil: null, failedLoginAttempts: 0 };

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
    ...lockout,
    teamMemberships: state.memberships.map((teamId) => ({ teamId })),
  };

  const tx = {
    user: {
      // The whole projection, not only what the invariant checks read: `unlock`
      // maps the row it finds straight into a response.
      findUnique: () => Promise.resolve(state.target === null ? null : { ...row, ...state.target }),
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
      updateMany: ({ where }: { where: Record<string, unknown> }) => {
        recorded.inviteWithdrawals.push(where);
        return Promise.resolve({ count: 1 });
      },
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
    // The routing references `remove` clears (TAR-79's invariant 4). Counts
    // only — what they are is asserted in `people-rbac.int-spec.ts` against real
    // rows; here they exist so the transaction body runs to the end.
    conversation: { updateMany: () => Promise.resolve({ count: 0 }) },
    ticket: { updateMany: () => Promise.resolve({ count: 0 }) },
    assignmentState: { updateMany: () => Promise.resolve({ count: 0 }) },
    assignmentRule: { updateMany: () => Promise.resolve({ count: 0 }) },
    // The same cleanup for workflows (TAR-27, 0009 delta 5). Empty here, so the
    // transaction body runs to the end without the deactivation branch; the
    // branch itself is asserted in `people-rbac.int-spec.ts` against real rows,
    // where the `NoAction` foreign key can actually refuse.
    workflowReference: {
      findMany: () => Promise.resolve([]),
      deleteMany: () => Promise.resolve({ count: 0 }),
    },
    workflow: { updateMany: () => Promise.resolve({ count: 0 }) },
    session: { deleteMany: () => Promise.resolve({ count: 1 }) },
    auditLog: { create: () => Promise.resolve({}) },
    $queryRaw: () => Promise.resolve(state.activeAdminIds.map((id) => ({ id }))),
  };

  const prisma = {
    // The non-transactional reads, for the paths that do not open one.
    user: { findMany: () => Promise.resolve([row]) },
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

  const loginThrottle = {
    clearAccountLock: (_tx: unknown, userId: string) => {
      recorded.unlockedUserIds.push(userId);
      // The real one reports whether the conditional `UPDATE` matched, which is
      // what decides whether an audit row is written.
      return Promise.resolve(lockout.lockedUntil !== null || lockout.failedLoginAttempts > 0);
    },
    clearEmailFailures: (tenantId: string, email: string) => {
      recorded.clearedEmailLocks.push({ tenantId, email });

      return Promise.resolve();
    },
  } as unknown as LoginThrottleService;

  return {
    users: new UsersService(prisma, tenantContext, audit, sessions, loginThrottle),
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

    // The same rule applied to an *invitation* moved to `IdentityModule` with
    // the invite flow (TAR-55); `role-assignment.spec.ts` covers it directly,
    // against the function both paths now call.
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

  describe('removing a user closes every way back in', () => {
    it('withdraws their outstanding invitation, so the emailed link cannot reinstate them', async () => {
      const { users, tenantContext, recorded } = buildService({
        target: activeAgent,
        activeAdminIds: [CALLER],
        teams: [],
        memberships: [],
      });

      await asPrincipal(tenantContext, 'admin', () => users.remove(TARGET));

      // Without this, `InviteService.activateAccount` refuses only `active` and
      // `suspended`: a `removed` row falls through to the update branch and is
      // set back to `active` with the invited role and the lockout counters
      // cleared. Whoever holds the link reinstates the account with no admin
      // action and no authentication beyond holding it.
      expect(recorded.inviteWithdrawals).toEqual([
        {
          tenantId: TENANT,
          email: 'target@example.invalid',
          acceptedAt: null,
          revokedAt: null,
        },
      ]);
      // Live invitations only. An accepted or already-withdrawn row is history
      // and stays as it is.
      expect(recorded.audits.map((entry) => entry.action)).toContain('user.removed');
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

describe('UsersService — lockout visibility and unlock (TAR-59)', () => {
  const lockedUntil = new Date('2026-08-11T09:15:00.000Z');
  const lockedOut = { lockedUntil, failedLoginAttempts: 10 };

  function withLockout(lockout: { lockedUntil: Date | null; failedLoginAttempts: number }) {
    return buildService({
      target: activeAgent,
      activeAdminIds: [CALLER, TARGET],
      teams: [],
      memberships: [],
      lockout,
    });
  }

  describe('who may see it', () => {
    it('shows an admin how close an account is to being locked out', async () => {
      const { users, tenantContext } = withLockout(lockedOut);

      const page = await asPrincipal(tenantContext, 'admin', () => users.list({ limit: 20 }));

      expect(page.items[0]?.security).toEqual({
        lockedUntil: lockedUntil.toISOString(),
        failedLoginAttempts: 10,
      });
    });

    it('tells an agent nothing, because every agent holds user:read', async () => {
      const { users, tenantContext } = withLockout(lockedOut);

      const page = await asPrincipal(tenantContext, 'agent', () => users.list({ limit: 20 }));

      // Flat fields would give anyone in the tenant a live readout of a named
      // colleague's failed attempts, and confirmation the moment they lock out.
      expect(page.items[0]?.security).toBeNull();
    });

    it('shows a supervisor, who may administer the same people', async () => {
      const { users, tenantContext } = withLockout(lockedOut);

      const page = await asPrincipal(tenantContext, 'supervisor', () => users.list({ limit: 20 }));

      expect(page.items[0]?.security).not.toBeNull();
    });

    it('reports an unlocked account as unlocked rather than as unknown', async () => {
      const { users, tenantContext } = withLockout({ lockedUntil: null, failedLoginAttempts: 0 });

      const page = await asPrincipal(tenantContext, 'admin', () => users.list({ limit: 20 }));

      // Never `null` for somebody who may see it: an admin reading `null` could
      // not tell "not locked" from "not allowed to know".
      expect(page.items[0]?.security).toEqual({ lockedUntil: null, failedLoginAttempts: 0 });
    });
  });

  describe('clearing it', () => {
    it('clears the lockout and answers with the cleared state', async () => {
      const { users, tenantContext, recorded } = withLockout(lockedOut);

      const response = await asPrincipal(tenantContext, 'admin', () => users.unlock(TARGET));

      expect(recorded.unlockedUserIds).toEqual([TARGET]);
      expect(response.security).toEqual({ lockedUntil: null, failedLoginAttempts: 0 });
      expect(recorded.audits.map((entry) => entry.action)).toEqual(['auth.unlock']);
    });

    it('clears the Redis lock as well, so the unlock is actually an unlock', async () => {
      const { users, tenantContext, recorded } = withLockout(lockedOut);

      const response = await asPrincipal(tenantContext, 'admin', () => users.unlock(TARGET));

      // The per-email lockout refuses this account for fifteen minutes from the
      // tenth failure, and an admin cannot see it. Clearing only the durable
      // columns would make "let them back in now" mean "in up to fifteen
      // minutes", refused by a layer nobody can point at.
      expect(recorded.clearedEmailLocks).toEqual([{ tenantId: TENANT, email: response.email }]);
    });

    it('records what it cleared, so the trail distinguishes a lockout from a creeping counter', async () => {
      const { users, tenantContext, recorded } = withLockout(lockedOut);

      await asPrincipal(tenantContext, 'admin', () => users.unlock(TARGET));

      expect(recorded.audits[0]?.metadata).toEqual({
        failedAttemptsCleared: 10,
        wasLockedUntil: lockedUntil.toISOString(),
      });
    });

    it('is a no-op on an account that was never locked, and is not audited as one', async () => {
      const { users, tenantContext, recorded } = withLockout({
        lockedUntil: null,
        failedLoginAttempts: 0,
      });

      const response = await asPrincipal(tenantContext, 'admin', () => users.unlock(TARGET));

      expect(response.security).toEqual({ lockedUntil: null, failedLoginAttempts: 0 });
      // A retried unlock must not leave a second row claiming the same account
      // was rescued twice.
      expect(recorded.audits).toEqual([]);
    });

    it('refuses an id that is not in this tenant', async () => {
      const { users, tenantContext } = buildService({
        target: null,
        activeAdminIds: [CALLER],
        teams: [],
        memberships: [],
      });

      // `not_found`, never `forbidden` — RLS makes "absent" and "somebody
      // else's" the same answer, and a 403 would confirm the id exists.
      await expect(
        asPrincipal(tenantContext, 'admin', () => users.unlock(TARGET)),
      ).rejects.toBeInstanceOf(UserNotFoundError);
    });

    it('leaves the account signed in: a lockout is not a compromise', async () => {
      const { users, tenantContext, recorded } = withLockout(lockedOut);

      await asPrincipal(tenantContext, 'admin', () => users.unlock(TARGET));

      expect(recorded.revokedUserIds).toEqual([]);
    });
  });
});
