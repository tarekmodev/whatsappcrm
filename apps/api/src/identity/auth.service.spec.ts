import { permissionsForRole } from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { AuthService } from './auth.service';
import { AccountLockedError, InvalidCredentialsError } from './identity.errors';
import { PasswordService } from './password.service';
import { SessionService, type IssuedSession } from './session.service';

/**
 * The login flow, one refusal at a time.
 *
 * The assertions worth reading twice are the ones about what login *does not*
 * do: it never answers differently for an unknown address than for a wrong
 * password, it never verifies a password against a locked account, and it never
 * issues a session outside the transaction that resets the lockout counters.
 * Each of those is a security property that a passing "happy path" test would
 * not notice losing.
 */

const TENANT = '56444444-4444-7444-8444-444444444401';
const USER = '56444444-4444-7444-8444-4444444444a1';
const SESSION = '56444444-4444-7444-8444-4444444444b1';
const TEAM = '56444444-4444-7444-8444-4444444444c1';

const CURRENT_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$dGFn';
const STALE_HASH = '$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$dGFn';

const LOGIN = { email: 'agent@acme.invalid', password: 'correct horse battery staple' };
const CONTEXT = { ipAddress: '203.0.113.7', userAgent: 'Firefox' };

interface CandidateOverrides {
  password_hash?: string | null;
  status?: string;
  locked?: boolean;
  lock_seconds_remaining?: number;
}

function candidate(overrides: CandidateOverrides = {}): Record<string, unknown> {
  return {
    id: USER,
    password_hash: CURRENT_HASH,
    status: 'active',
    role: 'supervisor',
    email: LOGIN.email,
    name: 'Ada',
    locked: false,
    lock_seconds_remaining: 0,
    team_ids: [TEAM],
    ...overrides,
  };
}

interface Harness {
  auth: AuthService;
  tenantContext: TenantContextService;
  statements: string[];
  issued: jest.Mock;
  published: jest.Mock;
  revokedAll: jest.Mock;
  revokedOne: jest.Mock;
  purged: jest.Mock;
  verify: jest.Mock;
  verifyDummy: jest.Mock;
  hash: jest.Mock;
  updates: Record<string, unknown>[];
}

/**
 * The statements are matched on their text, which is the price of writing them
 * out — and the same reason they are written out: nothing else can express
 * `now()` in a filter. The `int-spec` beside this file runs the real ones.
 */
function buildHarness(rows: { user?: Record<string, unknown> | null; failure?: unknown }): Harness {
  const statements: string[] = [];
  const updates: Record<string, unknown>[] = [];

  const queryRaw = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const sql = strings.join(' ? ');

    statements.push(sql);

    if (sql.includes('FROM users u')) {
      const user = rows.user === undefined ? candidate() : rows.user;

      return Promise.resolve(user === null ? [] : [user]);
    }

    if (sql.includes('UPDATE users')) {
      return Promise.resolve([rows.failure ?? { failed_login_attempts: 1, locked: false }]);
    }

    return Promise.resolve([]);
  };

  const tx = {
    $queryRaw: queryRaw,
    user: {
      update: ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return Promise.resolve({ id: USER });
      },
    },
  };

  const prisma = {
    $queryRaw: queryRaw,
    $tenantTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as TenantPrisma;

  const verify = jest.fn().mockResolvedValue(true);
  const verifyDummy = jest.fn().mockResolvedValue(undefined);
  const hash = jest.fn().mockResolvedValue('$argon2id$v=19$m=19456,t=2,p=1$bmV3$aGFzaA');
  const passwords = {
    verify,
    verifyDummy,
    hash,
    needsRehash: (encoded: string) => encoded === STALE_HASH,
  } as unknown as PasswordService;

  const issued = jest.fn().mockImplementation((): Promise<IssuedSession> =>
    Promise.resolve({
      token: 'plaintext-token',
      tokenHash: 'hash-of-token',
      sessionId: SESSION,
      expiresAt: new Date('2026-08-12T09:00:00.000Z'),
    }),
  );
  const published = jest.fn().mockResolvedValue(undefined);
  const revokedAll = jest.fn().mockResolvedValue(3);
  const revokedOne = jest.fn().mockResolvedValue('hash-of-token');
  const purged = jest.fn().mockResolvedValue(undefined);

  const sessions = {
    issue: issued,
    publish: published,
    revokeAllForUser: revokedAll,
    revokeOne: revokedOne,
    purgeCacheFor: purged,
  } as unknown as SessionService;

  const audit = { record: () => Promise.resolve() } as unknown as AuditService;
  const tenantContext = new TenantContextService();

  return {
    auth: new AuthService(prisma, tenantContext, passwords, sessions, audit),
    tenantContext,
    statements,
    issued,
    published,
    revokedAll,
    revokedOne,
    purged,
    verify,
    verifyDummy,
    hash,
    updates,
  };
}

function inTenant<T>(tenantContext: TenantContextService, work: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { requestId: 'tar56-spec', tenantId: TENANT, userId: null, principal: null },
    async () => await work(),
  );
}

describe('AuthService.login', () => {
  describe('refusals', () => {
    it.each([
      ['an address with no account', { user: null }],
      [
        'an invited account that has never set a password',
        { user: candidate({ password_hash: null }) },
      ],
      ['a suspended user', { user: candidate({ status: 'suspended' }) }],
      ['a removed user', { user: candidate({ status: 'removed' }) }],
    ])('answers invalid_credentials for %s, and burns a hash doing it', async (_label, rows) => {
      const harness = buildHarness(rows);

      await expect(
        inTenant(harness.tenantContext, () => harness.auth.login(LOGIN, CONTEXT)),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);

      // Without this the response *time* separates "no such user" from "wrong
      // password", and the endpoint is a user-enumeration oracle whatever the
      // body says.
      expect(harness.verifyDummy).toHaveBeenCalledWith(LOGIN.password);
      expect(harness.issued).not.toHaveBeenCalled();
    });

    it('answers the same message for all of them', async () => {
      const messages = await Promise.all(
        [null, candidate({ password_hash: null }), candidate({ status: 'suspended' })].map(
          async (user) => {
            const harness = buildHarness({ user });

            return await inTenant(harness.tenantContext, () => harness.auth.login(LOGIN, CONTEXT))
              .then(() => 'resolved')
              .catch((error: Error) => error.message);
          },
        ),
      );

      expect(new Set(messages).size).toBe(1);
    });

    it('refuses a locked account without verifying anything', async () => {
      const harness = buildHarness({
        user: candidate({ locked: true, lock_seconds_remaining: 812 }),
      });

      const error = await inTenant(harness.tenantContext, () =>
        harness.auth.login(LOGIN, CONTEXT),
      ).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(AccountLockedError);
      expect((error as AccountLockedError).retryAfterSeconds).toBe(812);
      // Verifying during a lockout would let an attacker keep testing guesses
      // and read the answer off the timing.
      expect(harness.verify).not.toHaveBeenCalled();
    });

    it('counts a wrong password and answers invalid_credentials', async () => {
      const harness = buildHarness({});

      harness.verify.mockResolvedValue(false);

      await expect(
        inTenant(harness.tenantContext, () => harness.auth.login(LOGIN, CONTEXT)),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);

      const counter = harness.statements.find((sql) => sql.includes('failed_login_attempts + 1'));

      expect(counter).toBeDefined();
      // The lock decision is inside the same statement as the increment, so two
      // concurrent failures cannot both read "nine" and both write "ten".
      expect(counter).toContain('locked_until = CASE');
      expect(harness.issued).not.toHaveBeenCalled();
    });
  });

  describe('success', () => {
    it('issues a session and materialises the principal from the role', async () => {
      const harness = buildHarness({});

      const { principal, issued } = await inTenant(harness.tenantContext, () =>
        harness.auth.login(LOGIN, CONTEXT),
      );

      expect(principal).toEqual({
        userId: USER,
        tenantId: TENANT,
        email: LOGIN.email,
        displayName: 'Ada',
        role: 'supervisor',
        // From the contract's own table, never a literal list: one place in the
        // system interprets a role, and it is not this one.
        permissions: [...permissionsForRole('supervisor')],
        teamIds: [TEAM],
        sessionId: SESSION,
        expiresAt: '2026-08-12T09:00:00.000Z',
      });
      expect(issued.token).toBe('plaintext-token');
    });

    it('resets the lockout counters in the same transaction that issues the session', async () => {
      const harness = buildHarness({});

      await inTenant(harness.tenantContext, () => harness.auth.login(LOGIN, CONTEXT));

      expect(harness.updates).toEqual([
        expect.objectContaining({ failedLoginAttempts: 0, lockedUntil: null }),
      ]);
      expect(harness.issued).toHaveBeenCalledTimes(1);
    });

    it('caches the principal only after the transaction has committed', async () => {
      const harness = buildHarness({});

      await inTenant(harness.tenantContext, () => harness.auth.login(LOGIN, CONTEXT));

      // A cache entry written inside a transaction that then rolled back would
      // be a live credential for a session that does not exist.
      expect(harness.published).toHaveBeenCalledTimes(1);
      expect(harness.issued.mock.invocationCallOrder[0]).toBeLessThan(
        harness.published.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('upgrades a hash written under weaker parameters', async () => {
      const harness = buildHarness({ user: candidate({ password_hash: STALE_HASH }) });

      await inTenant(harness.tenantContext, () => harness.auth.login(LOGIN, CONTEXT));

      expect(harness.hash).toHaveBeenCalledWith(LOGIN.password);
      expect(harness.updates[0]).toHaveProperty('passwordHash');
    });

    it('leaves a current hash alone', async () => {
      const harness = buildHarness({});

      await inTenant(harness.tenantContext, () => harness.auth.login(LOGIN, CONTEXT));

      expect(harness.hash).not.toHaveBeenCalled();
      expect(harness.updates[0]).not.toHaveProperty('passwordHash');
    });

    it('takes no tenant from the caller', async () => {
      const harness = buildHarness({});

      await inTenant(harness.tenantContext, () => harness.auth.login(LOGIN, CONTEXT));

      // The lookup filters on the address alone; RLS and the ambient tenant are
      // what confine it to one tenant's users. A tenant predicate on `users`
      // would mean a tenant had come from somewhere a caller can reach — the
      // `tm.tenant_id = u.tenant_id` in the team subquery above is a join
      // condition, which is why only the clause after the table is inspected.
      const lookup = harness.statements.find((sql) => sql.includes('FROM users u')) ?? '';
      const predicate = lookup.split('FROM users u')[1] ?? '';

      expect(predicate).toContain('WHERE u.email =');
      expect(predicate).not.toContain('tenant_id');
    });
  });
});

describe('AuthService.logout', () => {
  const principal = {
    userId: USER,
    tenantId: TENANT,
    email: LOGIN.email,
    displayName: 'Ada',
    role: 'supervisor' as const,
    permissions: [...permissionsForRole('supervisor')],
    teamIds: [TEAM],
    sessionId: SESSION,
    expiresAt: '2026-08-12T09:00:00.000Z',
  };

  it('revokes this session only, by default', async () => {
    const harness = buildHarness({});

    await inTenant(harness.tenantContext, () => harness.auth.logout(principal, false));

    expect(harness.revokedOne).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      USER,
      SESSION,
      'logout',
    );
    expect(harness.revokedAll).not.toHaveBeenCalled();
  });

  it('revokes every session when asked', async () => {
    const harness = buildHarness({});

    await inTenant(harness.tenantContext, () => harness.auth.logout(principal, true));

    expect(harness.revokedAll).toHaveBeenCalledWith(expect.anything(), TENANT, USER, 'logout_all');
    expect(harness.revokedOne).not.toHaveBeenCalled();
  });

  it('purges the cache after the commit, even when nothing was revoked', async () => {
    const harness = buildHarness({});

    harness.revokedOne.mockResolvedValue(null);

    await inTenant(harness.tenantContext, () => harness.auth.logout(principal, false));

    expect(harness.purged).toHaveBeenCalledWith(TENANT, USER);
  });
});
