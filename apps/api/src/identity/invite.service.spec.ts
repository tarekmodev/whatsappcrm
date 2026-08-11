import {
  permissionsForRole,
  type OutboundEmail,
  type SessionPrincipal,
  type TenantRole,
} from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  EmailAlreadyRegisteredError,
  RoleAssignmentNotPermittedError,
} from '../people/people.errors';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { hashAuthToken } from './auth-tokens';
import { InviteNotPendingError, InviteTokenInvalidError } from './identity.errors';
import { InviteService } from './invite.service';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordService } from './password.service';
import { createSessionToken, hashSessionToken } from './session-token';
import type { SessionService } from './session.service';

/**
 * The invite flow against a fake transaction.
 *
 * Fake rather than mocked-out-of-existence: the service's real body runs,
 * including the order it does things in — which is the part that matters here.
 * What is faked is the database's answers, so a test can put an invitation in
 * the exact state (expired, already used, withdrawn) that is awkward to reach
 * and easy to get wrong.
 *
 * Three things are deliberately **not** covered here and are covered against
 * real PostgreSQL in `invite-flow.int-spec.ts`, because a fake cannot prove
 * them: that the conditional `UPDATE` is what makes a link single-use under
 * concurrency, that the upsert lands on the partial unique index, and that RLS
 * hides another tenant's invitation.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000b1';
const ADMIN = '0192f0ff-0000-7000-8000-00000000a001';
const INVITE = '0192f0ff-0000-7000-8000-00000000c001';
const INVITEE = '0192f0ff-0000-7000-8000-00000000a009';
const TEAM = '0192f0ff-0000-7000-8000-00000000b001';
const SESSION = '0192f0ff-0000-7000-8000-0000000000ff';

const HOUR_MS = 60 * 60 * 1000;

interface UserRow {
  id: string;
  email: string;
  status: 'invited' | 'active' | 'suspended' | 'removed';
}

interface LookupRow {
  email: string;
  role: TenantRole;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  tenant_name: string;
  invited_by_name: string | null;
  server_now: Date;
}

interface FakeState {
  /** The `users` row for the address in play, or `null` when the address is new. */
  user: UserRow | null;
  /** What the token lookup answers. `undefined` is an unknown token. */
  lookup: LookupRow | undefined;
  /** Whether the conditional redemption `UPDATE` matches a row. */
  redeemable: boolean;
  /** The teams parked on the invitation, applied on acceptance. */
  pendingTeamIds: readonly string[];
  /** Teams that exist in the tenant. */
  teams: readonly string[];
  /** What `invite.findUnique` answers for the admin-facing routes. */
  invite: { id: string; email: string; acceptedAt: Date | null; revokedAt: Date | null } | null;
}

interface Recorded {
  audits: { action: string; targetType: string; metadata?: unknown }[];
  mail: OutboundEmail[];
  userWrites: Record<string, unknown>[];
  teamMemberships: { tenantId: string; teamId: string; userId: string }[];
  storedTokenHashes: string[];
  /** Principals published to the session cache, after the accepting transaction committed. */
  published: SessionPrincipal[];
  /** Addresses whose per-email lockout was cleared as part of the clean start. */
  clearedEmailLocks: string[];
}

function livePreview(overrides: Partial<LookupRow> = {}): LookupRow {
  const now = new Date('2026-08-11T10:00:00.000Z');

  return {
    email: 'invitee@example.invalid',
    role: 'supervisor',
    expires_at: new Date(now.getTime() + 24 * HOUR_MS),
    accepted_at: null,
    revoked_at: null,
    tenant_name: 'Acme Support',
    invited_by_name: 'Ada Admin',
    server_now: now,
    ...overrides,
  };
}

function principalFor(role: TenantRole): SessionPrincipal {
  return {
    userId: ADMIN,
    tenantId: TENANT,
    email: `${role}@example.invalid`,
    displayName: 'Ada Admin',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: '0192f0ff-0000-7000-8000-0000000000ff',
    expiresAt: '2026-12-31T23:59:59.000Z',
  };
}

function buildService(state: FakeState): {
  invites: InviteService;
  recorded: Recorded;
  tenantContext: TenantContextService;
} {
  const recorded: Recorded = {
    audits: [],
    mail: [],
    userWrites: [],
    teamMemberships: [],
    storedTokenHashes: [],
    published: [],
    clearedEmailLocks: [],
  };

  const upsertRow = {
    id: INVITE,
    email: state.lookup?.email ?? 'invitee@example.invalid',
    role: state.lookup?.role ?? 'agent',
    invited_by_user_id: ADMIN,
    expires_at: new Date('2026-08-18T10:00:00.000Z'),
    accepted_at: null,
    revoked_at: null,
    created_at: new Date('2026-08-11T10:00:00.000Z'),
    inserted: true,
  };

  // Answers by statement, because the service sends three different raw
  // statements and asserting on which one ran is half the point of the fake.
  const queryRaw = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const sql = strings.join('?');

    if (sql.includes('INSERT INTO invites')) {
      // Position 5 in the VALUES list is the token hash — the only form of the
      // token this service is allowed to persist.
      recorded.storedTokenHashes.push(String(values[4]));
      return Promise.resolve([{ ...upsertRow, role: values[3] as TenantRole }]);
    }

    if (sql.includes('UPDATE invites')) {
      return Promise.resolve(
        state.redeemable
          ? [
              {
                id: INVITE,
                email: state.lookup?.email ?? 'invitee@example.invalid',
                role: state.lookup?.role ?? 'agent',
              },
            ]
          : [],
      );
    }

    return Promise.resolve(state.lookup === undefined ? [] : [state.lookup]);
  };

  const tx = {
    user: {
      findFirst: () => Promise.resolve(state.user),
      create: ({ data }: { data: Record<string, unknown> }) => {
        recorded.userWrites.push(data);
        return Promise.resolve({ id: INVITEE, email: data.email, name: data.name });
      },
      update: ({ data }: { data: Record<string, unknown> }) => {
        recorded.userWrites.push(data);
        return Promise.resolve({
          id: state.user?.id ?? INVITEE,
          email: state.user?.email ?? 'invitee@example.invalid',
          name: data.name ?? 'Invitee',
        });
      },
    },
    team: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.filter((id) => state.teams.includes(id)).map((id) => ({ id }))),
    },
    invite: {
      findUnique: () => Promise.resolve(state.invite),
      update: () =>
        Promise.resolve({
          id: INVITE,
          email: 'invitee@example.invalid',
          role: 'agent',
          invitedByUserId: ADMIN,
          expiresAt: new Date('2026-08-18T10:00:00.000Z'),
          acceptedAt: null,
          revokedAt: null,
          createdAt: new Date('2026-08-11T10:00:00.000Z'),
          teams: [],
        }),
    },
    inviteTeam: {
      deleteMany: () => Promise.resolve({ count: 0 }),
      createMany: () => Promise.resolve({ count: 0 }),
      findMany: () => Promise.resolve(state.pendingTeamIds.map((teamId) => ({ teamId }))),
    },
    teamMember: {
      createMany: ({ data }: { data: { tenantId: string; teamId: string; userId: string }[] }) => {
        recorded.teamMemberships.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
    session: {
      create: () =>
        Promise.resolve({ id: '0192f0ff-0000-7000-8000-0000000000fe', expiresAt: new Date() }),
    },
    auditLog: {
      create: ({ data }: { data: { action: string; targetType: string; metadata?: unknown } }) => {
        recorded.audits.push(data);
        return Promise.resolve({});
      },
    },
    $queryRaw: queryRaw,
  };

  const prisma = {
    $tenantTransaction: <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
    $queryRaw: queryRaw,
    invite: { findMany: () => Promise.resolve([]) },
  } as unknown as TenantPrisma;

  const tenantContext = new TenantContextService();

  // Only the two halves of session issue the invite flow reaches. The real
  // `SessionService` is exercised against Postgres in `invite-flow.int-spec.ts`;
  // what this file asserts is that acceptance issues one at all, inside the same
  // transaction, and publishes it only after that transaction resolved.
  const sessions = {
    // A real token, so the "it never reaches the response body" assertion is
    // made against something of the right shape. Only the row write is faked.
    issue: () => {
      const token = createSessionToken();

      return Promise.resolve({
        token,
        tokenHash: hashSessionToken(token),
        sessionId: SESSION,
        expiresAt: new Date('2026-12-31T23:59:59.000Z'),
      });
    },
    publish: (_issued: unknown, principal: SessionPrincipal) => {
      recorded.published.push(principal);
      return Promise.resolve();
    },
  } as unknown as SessionService;

  // The per-email lockout counts every address typed at login, including one
  // with no account yet, so an accepted invite has to clear it alongside the
  // columns that give a reactivated account its clean start.
  const loginThrottle = {
    clearEmailFailures: (_tenantId: string, email: string) => {
      recorded.clearedEmailLocks.push(email);

      return Promise.resolve();
    },
  } as unknown as LoginThrottleService;

  const invites = new InviteService(
    prisma,
    {
      send: (message: OutboundEmail) => {
        recorded.mail.push(message);
        return Promise.resolve();
      },
    },
    tenantContext,
    new AuditService(tenantContext),
    new PasswordService(),
    sessions,
    loginThrottle,
  );

  return { invites, recorded, tenantContext };
}

function asPrincipal<T>(
  tenantContext: TenantContextService,
  role: TenantRole,
  work: () => Promise<T>,
): Promise<T> {
  const principal = principalFor(role);

  return tenantContext.run(
    { requestId: 'invite-spec', tenantId: TENANT, userId: ADMIN, principal },
    work,
  );
}

/** The unauthenticated half: a tenant in scope from the host, and nobody signed in. */
function asVisitor<T>(tenantContext: TenantContextService, work: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { requestId: 'invite-spec', tenantId: TENANT, userId: null, principal: null },
    work,
  );
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    user: null,
    lookup: livePreview(),
    redeemable: true,
    pendingTeamIds: [],
    teams: [TEAM],
    invite: null,
    ...overrides,
  };
}

describe('creating an invitation', () => {
  it('stores only the digest of the token, and mails the token itself', async () => {
    const { invites, recorded, tenantContext } = buildService(baseState());

    const { invite } = await asPrincipal(tenantContext, 'admin', () =>
      invites.create({ email: 'invitee@example.invalid', role: 'agent', teamIds: [] }),
    );

    const [mail] = recorded.mail;
    // The adapter assembles the URL from `linkPath` + `token`; the service only
    // ever hands over the token itself.
    const token = String(mail?.data.token);

    expect(token).not.toBe('');
    expect(recorded.storedTokenHashes).toEqual([hashAuthToken(token)]);
    // The plaintext must exist in the email and nowhere else — not in the
    // response, and not in the audit trail.
    expect(JSON.stringify(invite)).not.toContain(token);
    expect(JSON.stringify(recorded.audits)).not.toContain(token);
  });

  it('refuses a supervisor inviting anybody above an agent', async () => {
    const { invites, tenantContext } = buildService(baseState());

    for (const role of ['supervisor', 'admin'] as const) {
      await expect(
        asPrincipal(tenantContext, 'supervisor', () =>
          invites.create({ email: 'invitee@example.invalid', role, teamIds: [] }),
        ),
      ).rejects.toBeInstanceOf(RoleAssignmentNotPermittedError);
    }
  });

  it('refuses an address that already has a usable account', async () => {
    for (const status of ['active', 'suspended'] as const) {
      const { invites, tenantContext } = buildService(
        baseState({ user: { id: INVITEE, email: 'invitee@example.invalid', status } }),
      );

      await expect(
        asPrincipal(tenantContext, 'admin', () =>
          invites.create({ email: 'invitee@example.invalid', role: 'agent', teamIds: [] }),
        ),
      ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
    }
  });

  it('re-invites an address whose account was removed, rather than refusing it', async () => {
    const { invites, recorded, tenantContext } = buildService(
      baseState({ user: { id: INVITEE, email: 'invitee@example.invalid', status: 'removed' } }),
    );

    await asPrincipal(tenantContext, 'admin', () =>
      invites.create({ email: 'invitee@example.invalid', role: 'agent', teamIds: [] }),
    );

    // The same row is reused, so their history stays attributable to them.
    expect(recorded.userWrites).toEqual([{ role: 'agent', status: 'invited' }]);
  });

  it('parks the teams on the invitation instead of joining them now', async () => {
    const { invites, recorded, tenantContext } = buildService(baseState());

    await asPrincipal(tenantContext, 'admin', () =>
      invites.create({ email: 'invitee@example.invalid', role: 'agent', teamIds: [TEAM] }),
    );

    // Somebody who never accepts must never widen a team's membership.
    expect(recorded.teamMemberships).toEqual([]);
  });
});

describe('accepting an invitation', () => {
  const acceptance = {
    token: 'a-token-that-only-the-invitee-holds',
    displayName: 'Noor Sayed',
    password: 'a-perfectly-adequate-password',
  };
  const origin = { ipAddress: null, userAgent: null };

  it('activates the account with the role from the invitation, never from the request', async () => {
    const { invites, recorded, tenantContext } = buildService(
      baseState({ lookup: livePreview({ role: 'supervisor' }) }),
    );

    const accepted = await asVisitor(tenantContext, () => invites.accept(acceptance, origin));

    expect(accepted.principal.role).toBe('supervisor');
    expect(accepted.principal.tenantId).toBe(TENANT);
    expect(recorded.userWrites[0]).toMatchObject({ role: 'supervisor', status: 'active' });
  });

  it('stores the password as an argon2id hash and never in the clear', async () => {
    const { invites, recorded, tenantContext } = buildService(baseState());

    const accepted = await asVisitor(tenantContext, () => invites.accept(acceptance, origin));

    const stored = String(recorded.userWrites[0]?.passwordHash);

    expect(stored).toContain('$argon2id$');
    expect(stored).not.toContain(acceptance.password);
    await expect(new PasswordService().verify(stored, acceptance.password)).resolves.toBe(true);
    expect(JSON.stringify(accepted.principal)).not.toContain(acceptance.password);
  });

  it('joins the teams the invitation parked', async () => {
    const { invites, recorded, tenantContext } = buildService(
      baseState({ pendingTeamIds: [TEAM] }),
    );

    await asVisitor(tenantContext, () => invites.accept(acceptance, origin));

    expect(recorded.teamMemberships).toEqual([{ tenantId: TENANT, teamId: TEAM, userId: INVITEE }]);
  });

  it('clears the per-email lockout, so a guessed-at address can still sign in later', async () => {
    const { invites, recorded, tenantContext } = buildService(baseState());

    const accepted = await asVisitor(tenantContext, () => invites.accept(acceptance, origin));

    // The lockout counts every address typed at login, including one with no
    // account yet — so somebody guessing at an invitee's address before they
    // accept would otherwise lock them out of their own new account.
    expect(recorded.clearedEmailLocks).toEqual([accepted.principal.email]);
  });

  it('issues a session whose token is not in the response body', async () => {
    const { invites, tenantContext } = buildService(baseState());

    const accepted = await asVisitor(tenantContext, () => invites.accept(acceptance, origin));

    expect(accepted.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(accepted.principal)).not.toContain(accepted.sessionToken);
  });

  it.each([
    ['unknown', { lookup: undefined }],
    ['expired', { lookup: livePreview({ expires_at: new Date('2026-08-11T09:00:00.000Z') }) }],
    ['consumed', { lookup: livePreview({ accepted_at: new Date('2026-08-11T09:00:00.000Z') }) }],
    ['revoked', { lookup: livePreview({ revoked_at: new Date('2026-08-11T09:00:00.000Z') }) }],
  ])('refuses a %s token, and says which it was', async (reason, overrides) => {
    const { invites, recorded, tenantContext } = buildService(baseState(overrides));

    await expect(
      asVisitor(tenantContext, () => invites.accept(acceptance, origin)),
    ).rejects.toMatchObject({ reason });
    // Nothing is written on a refused acceptance — not the account, not a
    // session, not an audit row.
    expect(recorded.userWrites).toEqual([]);
    expect(recorded.audits).toEqual([]);
  });

  it('refuses when the redemption loses a race, even though the pre-flight read passed', async () => {
    const { invites, recorded, tenantContext } = buildService(baseState({ redeemable: false }));

    await expect(
      asVisitor(tenantContext, () => invites.accept(acceptance, origin)),
    ).rejects.toBeInstanceOf(InviteTokenInvalidError);
    expect(recorded.userWrites).toEqual([]);
  });

  it('refuses when the address gained an account between invitation and acceptance', async () => {
    const { invites, tenantContext } = buildService(
      baseState({ user: { id: INVITEE, email: 'invitee@example.invalid', status: 'active' } }),
    );

    await expect(
      asVisitor(tenantContext, () => invites.accept(acceptance, origin)),
    ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
  });
});

describe('withdrawing and resending', () => {
  it('is a no-op when the invitation is already withdrawn', async () => {
    const { invites, recorded, tenantContext } = buildService(
      baseState({
        invite: {
          id: INVITE,
          email: 'invitee@example.invalid',
          acceptedAt: null,
          revokedAt: new Date('2026-08-11T09:00:00.000Z'),
        },
      }),
    );

    await asPrincipal(tenantContext, 'admin', () => invites.revoke(INVITE));

    // No second audit row claiming it was withdrawn twice.
    expect(recorded.audits).toEqual([]);
  });

  it('refuses to withdraw or resend an invitation that was accepted', async () => {
    const state = baseState({
      invite: {
        id: INVITE,
        email: 'invitee@example.invalid',
        acceptedAt: new Date('2026-08-11T09:00:00.000Z'),
        revokedAt: null,
      },
    });

    const withdrawing = buildService(state);
    await expect(
      asPrincipal(withdrawing.tenantContext, 'admin', () => withdrawing.invites.revoke(INVITE)),
    ).rejects.toBeInstanceOf(InviteNotPendingError);

    const resending = buildService(state);
    await expect(
      asPrincipal(resending.tenantContext, 'admin', () => resending.invites.resend(INVITE)),
    ).rejects.toBeInstanceOf(InviteNotPendingError);
  });

  it('mails a different token on resend, so the previous link stops working', async () => {
    const { invites, recorded, tenantContext } = buildService(
      baseState({
        invite: { id: INVITE, email: 'invitee@example.invalid', acceptedAt: null, revokedAt: null },
      }),
    );

    await asPrincipal(tenantContext, 'admin', () => invites.resend(INVITE));
    await asPrincipal(tenantContext, 'admin', () => invites.resend(INVITE));

    const [first, second] = recorded.mail.map((message) => String(message.data.token));

    expect(first).not.toBe(second);
    expect(recorded.audits.map((entry) => entry.action)).toEqual([
      'invite.resent',
      'invite.resent',
    ]);
  });
});
