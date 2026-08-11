import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { AUTH_POLICY, permissionsForRole } from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { UsersService } from '../people/users.service';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { SessionRevocationService } from '../rbac/session-revocation.service';
import { AuthRedisClient } from './auth-redis.client';
import { AuthService } from './auth.service';
import {
  InvalidCredentialsError,
  RateLimitedError,
  SessionNotFoundError,
  TooManyAttemptsError,
} from './identity.errors';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordService } from './password.service';
import { SessionCacheService } from './session-cache.service';
import { SessionService } from './session.service';

/**
 * The session lifecycle against a real PostgreSQL, as `whatsappcrm_app` — the
 * role that holds no `BYPASSRLS`.
 *
 * A unit test can show that these services compose the right statements. Only
 * this can show that the statements have the effect they exist for, and three
 * of the acceptance criteria are properties of the *database* rather than of
 * any function:
 *
 *   * a session issued for one tenant resolves to nothing at another tenant's
 *     host, because RLS filters it — not because a comparison was remembered;
 *   * two people with the same address in two tenants sign into their own
 *     account, which is the bug an unscoped `findUnique({ where: { email } })`
 *     would produce and no unit test would catch;
 *   * suspending an agent ends their session at the commit, not at their next
 *     expiry.
 *
 * It also runs against the real Redis when one is configured, so the double
 * purge around a revocation is exercised rather than described.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Two fixture
 * tenants, every row carrying a fixed id, deleted before the run as well as
 * after it so an interrupted run cleans up on the next one. Point `pnpm test:db`
 * at a local or disposable database.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`.
 */

const TENANT_A = '56999999-9999-7999-8999-999999999901';
const TENANT_B = '56999999-9999-7999-8999-999999999902';
const ADMIN_A = '56999999-9999-7999-8999-9999999999a0';
const AGENT_A = '56999999-9999-7999-8999-9999999999a1';
const AGENT_B = '56999999-9999-7999-8999-9999999999b1';
const TEAM_A = '56999999-9999-7999-8999-9999999999c1';

/** The same address in both tenants. `UNIQUE (tenant_id, email)` allows it, and real customers do it. */
const SHARED_EMAIL = 'tar56-shared@example.invalid';
const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'incorrect horse battery staple';

const REQUEST_ID = 'tar56-int-spec';

describe('the session lifecycle, end to end', () => {
  const tenantContext = new TenantContextService();
  const passwords = new PasswordService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let redis: AuthRedisClient;
  let cache: SessionCacheService;
  let sessions: SessionService;
  let auth: AuthService;
  let users: UsersService;
  let throttle: LoginThrottleService;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null, principal: null },
      async () => await work(),
    );
  }

  /** Runs `work` as the tenant's admin, which is what `UsersService` requires. */
  function asAdmin<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      {
        requestId: REQUEST_ID,
        tenantId: TENANT_A,
        userId: ADMIN_A,
        principal: {
          userId: ADMIN_A,
          tenantId: TENANT_A,
          email: 'tar56-admin@example.invalid',
          displayName: 'Admin',
          role: 'admin',
          permissions: [...permissionsForRole('admin')],
          teamIds: [],
          sessionId: '56999999-9999-7999-8999-9999999999f0',
          expiresAt: '2026-12-31T23:59:59.000Z',
        },
      },
      async () => await work(),
    );
  }

  /** The same, as the fixture agent — who holds `user:read` and not `user:update`. */
  function asAgent<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      {
        requestId: REQUEST_ID,
        tenantId: TENANT_A,
        userId: AGENT_A,
        principal: {
          userId: AGENT_A,
          tenantId: TENANT_A,
          email: SHARED_EMAIL,
          displayName: 'Ada in A',
          role: 'agent',
          permissions: [...permissionsForRole('agent')],
          teamIds: [TEAM_A],
          sessionId: '56999999-9999-7999-8999-9999999999f1',
          expiresAt: '2026-12-31T23:59:59.000Z',
        },
      },
      async () => await work(),
    );
  }

  async function removeFixture(): Promise<void> {
    // `sessions`, `team_members` and `audit_logs` all cascade from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  async function seedFixture(): Promise<void> {
    const passwordHash = await passwords.hash(PASSWORD);

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar56-fixture-a', name: 'TAR-56 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar56-fixture-b', name: 'TAR-56 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.user.createMany({
      data: [
        {
          id: ADMIN_A,
          tenantId: TENANT_A,
          email: 'tar56-admin@example.invalid',
          name: 'Admin',
          role: 'admin',
          status: 'active',
          passwordHash,
        },
        {
          id: AGENT_A,
          tenantId: TENANT_A,
          email: SHARED_EMAIL,
          name: 'Ada in A',
          role: 'agent',
          status: 'active',
          passwordHash,
        },
        {
          id: AGENT_B,
          tenantId: TENANT_B,
          email: SHARED_EMAIL,
          name: 'Ada in B',
          role: 'supervisor',
          status: 'active',
          passwordHash,
        },
      ],
    });
    await systemPrisma.team.create({
      data: { id: TEAM_A, tenantId: TENANT_A, name: 'TAR-56 team' },
    });
    await systemPrisma.teamMember.create({
      data: { tenantId: TENANT_A, teamId: TEAM_A, userId: AGENT_A },
    });
  }

  /** Signs the fixture agent in and hands back the cookie value. */
  async function signIn(tenantId: string): Promise<string> {
    const { issued } = await asTenant(
      tenantId,
      async () =>
        await auth.login(
          { email: SHARED_EMAIL, password: PASSWORD },
          { ipAddress: '203.0.113.7', userAgent: 'int-spec' },
        ),
    );

    return issued.token;
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    const config = {
      get: (key: string) => {
        if (key === 'REDIS_URL') {
          return process.env.REDIS_URL;
        }

        // Enforced here regardless of the deployment default: this suite drives
        // the service directly and supplies the address itself, so it is
        // genuinely per-client.
        return key === 'LOGIN_IP_THROTTLE_ENABLED' ? true : undefined;
      },
    } as unknown as ConfigService;

    redis = new AuthRedisClient(config);
    cache = new SessionCacheService(redis);
    sessions = new SessionService(tenantPrisma, cache, new EventEmitter2());

    const audit = new AuditService(tenantContext);

    throttle = new LoginThrottleService(tenantPrisma, redis, audit, config);
    auth = new AuthService(tenantPrisma, tenantContext, passwords, sessions, throttle);
    users = new UsersService(
      tenantPrisma,
      tenantContext,
      audit,
      new SessionRevocationService(audit, sessions),
      throttle,
    );

    await removeFixture();
    await seedFixture();
  }, 60_000);

  afterAll(async () => {
    await removeFixture();
    await redis.onApplicationShutdown();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    // Every test starts from a clean session table, a clean audit trail and
    // clean lockout counters, so they pass in any order.
    await systemPrisma.session.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.auditLog.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.user.updateMany({
      where: { id: { in: [AGENT_A, AGENT_B] } },
      data: { failedLoginAttempts: 0, lockedUntil: null, status: 'active' },
    });
    await cache.purgeUser(TENANT_A, AGENT_A, true);
    await cache.purgeUser(TENANT_B, AGENT_B, true);
    // And clean Redis counters, so a re-run does not inherit the last test's
    // failures — all three of them outlive the fixture rows by design, and the
    // email lock outlives them for a full fifteen minutes.
    await dropRedisCounters(['authfail', 'emailfail', 'emaillock'], [TENANT_A, TENANT_B]);
  });

  describe('login resolves the tenant from scope, never from the request', () => {
    it('signs the same address into a different account in each tenant', async () => {
      const inA = await asTenant(
        TENANT_A,
        async () => await auth.login({ email: SHARED_EMAIL, password: PASSWORD }, blankContext()),
      );
      const inB = await asTenant(
        TENANT_B,
        async () => await auth.login({ email: SHARED_EMAIL, password: PASSWORD }, blankContext()),
      );

      // The bug this rules out: an unscoped lookup by email returns whichever
      // row the planner reached first, and somebody with accounts at two client
      // organisations signs into the wrong one.
      expect(inA.principal.userId).toBe(AGENT_A);
      expect(inA.principal.role).toBe('agent');
      expect(inA.principal.teamIds).toEqual([TEAM_A]);

      expect(inB.principal.userId).toBe(AGENT_B);
      expect(inB.principal.role).toBe('supervisor');
      expect(inB.principal.teamIds).toEqual([]);
    }, 30_000);

    it('refuses an address that exists only in another tenant', async () => {
      await expect(
        asTenant(
          TENANT_B,
          async () =>
            await auth.login(
              { email: 'tar56-admin@example.invalid', password: PASSWORD },
              blankContext(),
            ),
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    }, 30_000);
  });

  describe('resolution', () => {
    it('turns the cookie into the caller, with permissions from the role', async () => {
      const token = await signIn(TENANT_A);

      const principal = await asTenant(
        TENANT_A,
        async () => await sessions.resolve(token, TENANT_A),
      );

      expect(principal).toMatchObject({
        userId: AGENT_A,
        tenantId: TENANT_A,
        role: 'agent',
        teamIds: [TEAM_A],
        permissions: [...permissionsForRole('agent')],
      });
    }, 30_000);

    it('resolves to nothing when the cookie is replayed at another tenant', async () => {
      const token = await signIn(TENANT_A);

      // Row-level security is the defence, not a tenant comparison in code: the
      // statement runs with tenant B in scope and matches zero rows.
      const replayed = await asTenant(
        TENANT_B,
        async () => await sessions.resolve(token, TENANT_B),
      );

      expect(replayed).toBeNull();
    }, 30_000);

    it('refuses an unknown token', async () => {
      await expect(
        asTenant(TENANT_A, async () => await sessions.resolve('not-a-real-token', TENANT_A)),
      ).resolves.toBeNull();
    }, 30_000);

    it('slides the idle deadline once the throttle has elapsed, and not before', async () => {
      const token = await signIn(TENANT_A);

      const issued = await sessionRow();

      // Same request second: inside the throttle, so nothing moves.
      await asTenant(TENANT_A, async () => await sessions.resolve(token, TENANT_A));
      await cache.purgeUser(TENANT_A, AGENT_A, true);
      await asTenant(TENANT_A, async () => await sessions.resolve(token, TENANT_A));

      expect((await sessionRow()).expiresAt.getTime()).toBe(issued.expiresAt.getTime());

      // Age the session past the throttle rather than waiting five minutes.
      await systemPrisma.session.updateMany({
        where: { tenantId: TENANT_A },
        data: {
          lastSeenAt: new Date(Date.now() - AUTH_POLICY.sessionSlideThrottleMs - 60_000),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await cache.purgeUser(TENANT_A, AGENT_A, true);

      await asTenant(TENANT_A, async () => await sessions.resolve(token, TENANT_A));

      const slid = await sessionRow();

      expect(slid.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
      // Never past the cap, whatever the idle window says.
      expect(slid.expiresAt.getTime()).toBeLessThanOrEqual(slid.absoluteExpiresAt.getTime());
    }, 30_000);
  });

  describe('revocation is immediate', () => {
    it('ends every session the moment an admin suspends the agent', async () => {
      const token = await signIn(TENANT_A);

      // Warm the cache, so the test is about revocation beating a cached
      // principal rather than about an empty cache.
      await asTenant(TENANT_A, async () => await sessions.resolve(token, TENANT_A));

      await asAdmin(async () => await users.update(AGENT_A, { status: 'suspended' }));

      // The very next request, well inside the 60-second cache TTL.
      const afterSuspension = await asTenant(
        TENANT_A,
        async () => await sessions.resolve(token, TENANT_A),
      );

      expect(afterSuspension).toBeNull();

      const row = await sessionRow();

      expect(row.revokedAt).not.toBeNull();
      // The trail can say *why* every session for one person died at 14:03.
      expect(row.revokedReason).toBe('status_change');
    }, 30_000);

    it('ends every session when an admin removes the agent', async () => {
      const token = await signIn(TENANT_A);

      await asTenant(TENANT_A, async () => await sessions.resolve(token, TENANT_A));
      await asAdmin(async () => await users.remove(AGENT_A));

      await expect(
        asTenant(TENANT_A, async () => await sessions.resolve(token, TENANT_A)),
      ).resolves.toBeNull();
      expect((await sessionRow()).revokedReason).toBe('removed');
    }, 30_000);

    it('signs one device out without touching the others', async () => {
      const first = await signIn(TENANT_A);
      const second = await signIn(TENANT_A);

      const principal = await asTenant(
        TENANT_A,
        async () => await sessions.resolve(first, TENANT_A),
      );

      await asTenant(
        TENANT_A,
        async () => await sessions.revokeOwn(principal!, principal!.sessionId),
      );

      await expect(
        asTenant(TENANT_A, async () => await sessions.resolve(first, TENANT_A)),
      ).resolves.toBeNull();
      await expect(
        asTenant(TENANT_A, async () => await sessions.resolve(second, TENANT_A)),
      ).resolves.not.toBeNull();
    }, 30_000);

    it('refuses to revoke a session belonging to somebody else', async () => {
      const mine = await signIn(TENANT_A);
      const theirsToken = await signIn(TENANT_B);

      const mineResolved = await asTenant(
        TENANT_A,
        async () => await sessions.resolve(mine, TENANT_A),
      );
      const theirs = await asTenant(
        TENANT_B,
        async () => await sessions.resolve(theirsToken, TENANT_B),
      );

      await expect(
        asTenant(TENANT_A, async () => await sessions.revokeOwn(mineResolved!, theirs!.sessionId)),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    }, 30_000);

    it('logs out of every device at once when asked', async () => {
      const first = await signIn(TENANT_A);
      const second = await signIn(TENANT_A);

      const principal = await asTenant(
        TENANT_A,
        async () => await sessions.resolve(first, TENANT_A),
      );

      await asTenant(TENANT_A, async () => await auth.logout(principal!, true));

      for (const token of [first, second]) {
        await expect(
          asTenant(TENANT_A, async () => await sessions.resolve(token, TENANT_A)),
        ).resolves.toBeNull();
      }
    }, 30_000);
  });

  describe('lockout', () => {
    it('locks the account on the threshold and answers 429 rather than confirming it exists', async () => {
      await lockOutAgentA();

      // The correct password now, which is the point: a locked account is
      // locked, not merely rate limited on wrong guesses.
      const error = await asTenant(
        TENANT_A,
        async () => await auth.login({ email: SHARED_EMAIL, password: PASSWORD }, blankContext()),
      ).catch((thrown: unknown) => thrown);

      // `RateLimitedError`, not one of its two subclasses. With a Redis
      // configured the per-email lock trips on the same attempt and is checked
      // first; without one it is `AccountLockedError`. Which of the two fired is
      // exactly what must not be observable — same 429, same message, same
      // `Retry-After` — so asserting the subclass here would be asserting the
      // thing the design promises a caller cannot see.
      expect(error).toBeInstanceOf(RateLimitedError);
      expect((error as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);

      const locked = await systemPrisma.user.findUniqueOrThrow({
        where: { id: AGENT_A },
        select: { failedLoginAttempts: true, lockedUntil: true },
      });

      expect(locked.failedLoginAttempts).toBe(AUTH_POLICY.loginFailureThreshold);
      expect(locked.lockedUntil).not.toBeNull();

      // The lockout is confined to the tenant whose agent tripped it. The other
      // tenant's identically-addressed account is untouched.
      const neighbour = await systemPrisma.user.findUniqueOrThrow({
        where: { id: AGENT_B },
        select: { failedLoginAttempts: true, lockedUntil: true },
      });

      expect(neighbour).toEqual({ failedLoginAttempts: 0, lockedUntil: null });
    }, 120_000);

    it('lets an admin clear a lockout before the window elapses', async () => {
      await lockOutAgentA();

      const unlocked = await asAdmin(async () => await users.unlock(AGENT_A));

      // The state an admin reads back, and the reason the columns are durable
      // rather than a Redis counter: this is what makes the lockout observable.
      expect(unlocked.security).toEqual({ lockedUntil: null, failedLoginAttempts: 0 });

      // And the account can actually sign in again, which is the point.
      await expect(signIn(TENANT_A)).resolves.toEqual(expect.any(String));

      const trail = await systemPrisma.auditLog.findMany({
        where: {
          tenantId: TENANT_A,
          targetId: AGENT_A,
          action: { in: ['auth.lockout', 'auth.unlock'] },
        },
        select: { action: true },
        orderBy: { createdAt: 'asc' },
      });

      expect(trail.map((entry) => entry.action)).toEqual(['auth.lockout', 'auth.unlock']);
    }, 120_000);

    it('hides the lockout from an agent and shows it to an admin', async () => {
      await lockOutAgentA();

      const asSeenByAdmin = await asAdmin(async () => await users.list({ limit: 20 }));
      const asSeenByAgent = await asAgent(async () => await users.list({ limit: 20 }));

      expect(
        asSeenByAdmin.items.find((user) => user.id === AGENT_A)?.security?.failedLoginAttempts,
      ).toBe(AUTH_POLICY.loginFailureThreshold);
      // `user:read` is an agent permission; the lockout is not an agent's
      // business, and a flat field would report a colleague's every failure.
      expect(asSeenByAgent.items.find((user) => user.id === AGENT_A)?.security).toBeNull();
    }, 120_000);

    it('forgets a run of failures older than the lockout period, as the Redis counter does', async () => {
      await failLoginAsAgentA(AUTH_POLICY.loginFailureThreshold - 1);

      // The pause an attacker takes, without waiting fifteen minutes for it: the
      // Redis counter's key expires here, and the durable counter has to forget
      // at the same moment or the two are out of step (TAR-154). Before the fix
      // the durable counter was still at nine, so the attempt below locked the
      // account and the one after it answered 429 — while the same eleven
      // attempts against an address with no account answered 401 throughout.
      // That difference is the account-existence oracle, reopened by one pause.
      await systemPrisma.user.update({
        where: { id: AGENT_A },
        data: { lastFailedLoginAt: new Date(Date.now() - AUTH_POLICY.loginLockoutMs - 60_000) },
      });
      await dropRedisCounters(['emailfail', 'emaillock'], [TENANT_A]);

      await failLoginAsAgentA(1);

      const after = await systemPrisma.user.findUniqueOrThrow({
        where: { id: AGENT_A },
        select: { failedLoginAttempts: true, lockedUntil: true },
      });

      // The run restarted rather than reaching the threshold.
      expect(after).toEqual({ failedLoginAttempts: 1, lockedUntil: null });

      // And the next attempt is refused on its credentials, which is the answer
      // an address with no account here gives. `InvalidCredentialsError` rather
      // than `RateLimitedError` is the whole assertion: a 429 at this point is
      // reachable only for an account that exists.
      await failLoginAsAgentA(1);
    }, 120_000);

    it('resets the counter on a successful sign-in', async () => {
      await expect(
        asTenant(
          TENANT_A,
          async () =>
            await auth.login({ email: SHARED_EMAIL, password: WRONG_PASSWORD }, blankContext()),
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);

      await signIn(TENANT_A);

      const after = await systemPrisma.user.findUniqueOrThrow({
        where: { id: AGENT_A },
        select: { failedLoginAttempts: true, lockedUntil: true, lastLoginAt: true },
      });

      expect(after.failedLoginAttempts).toBe(0);
      expect(after.lockedUntil).toBeNull();
      expect(after.lastLoginAt).not.toBeNull();
    }, 60_000);
  });

  describe('the per-address window', () => {
    /**
     * Runs against the real Redis when one is configured. Without it the window
     * fails open by design, so the suite says so rather than asserting nothing.
     */
    const withRedis = process.env.REDIS_URL === undefined ? it.skip : it;

    withRedis(
      'stops an address spraying addresses that have no account here',
      async () => {
        const address = '198.51.100.77';

        // Every attempt names an address that does not exist in this tenant, so
        // there is no per-account counter to trip — only the window can see this.
        for (let attempt = 0; attempt < AUTH_POLICY.ipFailureThreshold; attempt += 1) {
          await expect(
            asTenant(
              TENANT_A,
              async () =>
                await auth.login(
                  { email: `tar59-nobody-${attempt}@example.invalid`, password: WRONG_PASSWORD },
                  { ipAddress: address, userAgent: 'int-spec' },
                ),
            ),
          ).rejects.toBeInstanceOf(InvalidCredentialsError);
        }

        const error = await asTenant(
          TENANT_A,
          async () =>
            await auth.login(
              { email: SHARED_EMAIL, password: PASSWORD },
              { ipAddress: address, userAgent: 'int-spec' },
            ),
        ).catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(TooManyAttemptsError);
        expect((error as TooManyAttemptsError).retryAfterSeconds).toBeGreaterThan(0);

        // The same address against the other tenant is untouched: the key carries
        // the tenant, so one tenant's attacker cannot deny service to another's.
        await expect(
          asTenant(
            TENANT_B,
            async () =>
              await auth.login(
                { email: SHARED_EMAIL, password: PASSWORD },
                { ipAddress: address, userAgent: 'int-spec' },
              ),
          ),
        ).resolves.toBeDefined();
      },
      120_000,
    );
  });

  /** Ten wrong passwords against the fixture agent, which is what locks them out. */
  async function lockOutAgentA(): Promise<void> {
    await failLoginAsAgentA(AUTH_POLICY.loginFailureThreshold);
  }

  /** `times` wrong passwords, each of which must be refused on its credentials. */
  async function failLoginAsAgentA(times: number): Promise<void> {
    for (let attempt = 0; attempt < times; attempt += 1) {
      await expect(
        asTenant(
          TENANT_A,
          async () =>
            await auth.login({ email: SHARED_EMAIL, password: WRONG_PASSWORD }, blankContext()),
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    }
  }

  /** Deletes login counters, which is what their TTL does fifteen minutes later. */
  async function dropRedisCounters(kinds: string[], tenantIds: string[]): Promise<void> {
    await redis.run('int-spec cleanup', async (client) => {
      const patterns = kinds.flatMap((kind) =>
        tenantIds.map((tenantId) => `wac:auth:${kind}:${tenantId}:*`),
      );

      const keys = (await Promise.all(patterns.map(async (pattern) => await client.keys(pattern))))
        .flat()
        .filter((key) => key.length > 0);

      if (keys.length > 0) {
        await client.del(...keys);
      }
    });
  }

  /** The single fixture session, read unscoped so the assertion sees revoked rows too. */
  async function sessionRow(): Promise<{
    expiresAt: Date;
    absoluteExpiresAt: Date;
    revokedAt: Date | null;
    revokedReason: string | null;
  }> {
    const [row] = await systemPrisma.session.findMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
      select: {
        expiresAt: true,
        absoluteExpiresAt: true,
        revokedAt: true,
        revokedReason: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (row === undefined) {
      throw new Error('The fixture session is missing.');
    }

    return row;
  }
});

function blankContext(): { ipAddress: string | null; userAgent: string | null } {
  return { ipAddress: null, userAgent: null };
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. This suite needs a real PostgreSQL: see the header comment.`,
    );
  }

  return value;
}
