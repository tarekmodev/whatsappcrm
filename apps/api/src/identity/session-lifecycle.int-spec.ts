import { ConfigService } from '@nestjs/config';
import { AUTH_POLICY, permissionsForRole } from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { UsersService } from '../people/users.service';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { SessionRevocationService } from '../rbac/session-revocation.service';
import { AuthService } from './auth.service';
import {
  AccountLockedError,
  InvalidCredentialsError,
  SessionNotFoundError,
} from './identity.errors';
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
  let cache: SessionCacheService;
  let sessions: SessionService;
  let auth: AuthService;
  let users: UsersService;

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
      get: (key: string) => (key === 'REDIS_URL' ? process.env.REDIS_URL : undefined),
    } as unknown as ConfigService;

    cache = new SessionCacheService(config);
    sessions = new SessionService(tenantPrisma, cache);

    const audit = new AuditService(tenantContext);

    auth = new AuthService(tenantPrisma, tenantContext, passwords, sessions, audit);
    users = new UsersService(
      tenantPrisma,
      tenantContext,
      audit,
      new SessionRevocationService(audit, sessions),
    );

    await removeFixture();
    await seedFixture();
  }, 60_000);

  afterAll(async () => {
    await removeFixture();
    await cache.onApplicationShutdown();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    // Every test starts from a clean session table and clean lockout counters,
    // so they pass in any order.
    await systemPrisma.session.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.user.updateMany({
      where: { id: { in: [AGENT_A, AGENT_B] } },
      data: { failedLoginAttempts: 0, lockedUntil: null, status: 'active' },
    });
    await cache.purgeUser(TENANT_A, AGENT_A, true);
    await cache.purgeUser(TENANT_B, AGENT_B, true);
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
      for (let attempt = 0; attempt < AUTH_POLICY.loginFailureThreshold; attempt += 1) {
        await expect(
          asTenant(
            TENANT_A,
            async () =>
              await auth.login({ email: SHARED_EMAIL, password: WRONG_PASSWORD }, blankContext()),
          ),
        ).rejects.toBeInstanceOf(InvalidCredentialsError);
      }

      // The correct password now, which is the point: a locked account is
      // locked, not merely rate limited on wrong guesses.
      const error = await asTenant(
        TENANT_A,
        async () => await auth.login({ email: SHARED_EMAIL, password: PASSWORD }, blankContext()),
      ).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(AccountLockedError);
      expect((error as AccountLockedError).retryAfterSeconds).toBeGreaterThan(0);

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
