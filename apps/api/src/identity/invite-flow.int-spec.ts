import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ConfigService } from '@nestjs/config';
import {
  permissionsForRole,
  type OutboundEmail,
  type SessionPrincipal,
  type TenantRole,
} from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PlanLimitsService } from '../entitlements/plan-limits.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { hashAuthToken } from './auth-tokens';
import { AuthRedisClient } from './auth-redis.client';
import { InviteTokenInvalidError } from './identity.errors';
import { InviteService } from './invite.service';
import { LoginThrottleService } from './login-throttle.service';
import { SessionCacheService } from './session-cache.service';
import { hashSessionToken } from './session-token';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

/**
 * TAR-55 against a real PostgreSQL, as `whatsappcrm_app` — the role that holds
 * no `BYPASSRLS`.
 *
 * Four properties live here because a fake cannot prove any of them:
 *
 *   * **Single use is a statement, not a check.** Two simultaneous acceptances
 *     of one link are run for real, and exactly one of them may win.
 *   * **Re-inviting cannot fail.** The upsert has to land on
 *     `invites_one_live_per_email`, a *partial* unique index — the thing Prisma
 *     cannot express and therefore the thing worth exercising.
 *   * **A token is confined to its tenant by RLS**, not by a comparison someone
 *     could forget to write. Tenant B is put in scope and handed tenant A's
 *     token.
 *   * **Only hashes are stored.** The row is read back and compared against the
 *     token that was mailed.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids, deleted before the run as well as after it, so an
 * interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '55888888-8888-7888-8888-888888888801';
const TENANT_B = '55888888-8888-7888-8888-888888888802';
const ADMIN_A = '55888888-8888-7888-8888-8888888888a1';
const ADMIN_B = '55888888-8888-7888-8888-8888888888b1';
const TEAM_A = '55888888-8888-7888-8888-88888888a001';

const INVITEE = 'noor@tar55-fixture-a.invalid';
const PASSWORD = 'a-perfectly-adequate-password';

const REQUEST_ID = 'tar55-int-spec';

describe('the invite flow', () => {
  const tenantContext = new TenantContextService();
  const mailbox: OutboundEmail[] = [];

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let invites: InviteService;
  let redis: AuthRedisClient;
  let cache: SessionCacheService;
  let throttleConfig: ConfigService;

  function principalFor(tenantId: string, userId: string, role: TenantRole): SessionPrincipal {
    return {
      userId,
      tenantId,
      email: `admin@${tenantId}.invalid`,
      displayName: 'Fixture Admin',
      role,
      permissions: [...permissionsForRole(role)],
      teamIds: [],
      sessionId: '55888888-8888-7888-8888-8888888888ff',
      expiresAt: '2026-12-31T23:59:59.000Z',
    };
  }

  /** An authenticated admin acting inside their own tenant. */
  function asAdmin<T>(tenantId: string, userId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      {
        requestId: REQUEST_ID,
        tenantId,
        userId,
        principal: principalFor(tenantId, userId, 'admin'),
      },
      work,
    );
  }

  /** The unauthenticated half: a tenant resolved from the host, and nobody signed in. */
  function asVisitor<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null, principal: null },
      work,
    );
  }

  function mailedToken(): string {
    // The service hands the adapter `linkPath` + `token` and lets it resolve the
    // tenant's primary host; the plaintext token is the part under test here.
    return String(mailbox.at(-1)?.data.token);
  }

  async function removeFixture(): Promise<void> {
    // Users, invites, sessions and domains all cascade from the tenant.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);
    redis = new AuthRedisClient({
      get: (key: string) => (key === 'REDIS_URL' ? process.env.REDIS_URL : undefined),
    } as unknown as ConfigService);
    cache = new SessionCacheService(redis);
    // The real throttle, so accepting an invite clears the per-email lockout
    // against the same Redis this suite is already talking to. The client
    // address window stays off — this suite supplies no address.
    throttleConfig = {
      get: () => undefined,
    } as unknown as ConfigService;

    await removeFixture();

    for (const [tenantId, slug, adminId] of [
      [TENANT_A, 'tar55-fixture-a', ADMIN_A],
      [TENANT_B, 'tar55-fixture-b', ADMIN_B],
    ] as const) {
      await systemPrisma.tenant.create({
        data: {
          id: tenantId,
          slug,
          name: `TAR-55 fixture ${slug}`,
          status: 'active',
          domains: {
            create: {
              hostname: `${slug}.app.localhost`,
              kind: 'platform',
              isPrimary: true,
              verifiedAt: new Date(),
            },
          },
          users: {
            create: {
              id: adminId,
              email: `admin@${slug}.invalid`,
              name: 'Fixture Admin',
              role: 'admin',
              status: 'active',
            },
          },
        },
      });
    }

    await systemPrisma.team.create({
      data: { id: TEAM_A, tenantId: TENANT_A, name: 'Billing' },
    });

    invites = new InviteService(
      tenantPrisma,
      {
        send: (message: OutboundEmail) => {
          mailbox.push(message);
          return Promise.resolve();
        },
      },
      tenantContext,
      new AuditService(tenantContext),
      new PasswordService(),
      new SessionService(tenantPrisma, cache, new EventEmitter2()),
      new LoginThrottleService(
        tenantPrisma,
        redis,
        new AuditService(tenantContext),
        throttleConfig,
      ),
      new PlanLimitsService(),
    );
  });

  afterAll(async () => {
    await removeFixture();
    await redis.onApplicationShutdown();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    // Each test starts from "nobody has been invited": the invite row and the
    // reserved account both go, so tests pass in any order.
    await systemPrisma.invite.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.user.deleteMany({ where: { email: INVITEE } });
    mailbox.length = 0;
  });

  async function inviteAgent(role: TenantRole = 'agent', teamIds: string[] = []) {
    return asAdmin(TENANT_A, ADMIN_A, () => invites.create({ email: INVITEE, role, teamIds }));
  }

  describe('creating one', () => {
    it('stores the digest of the token and never the token', async () => {
      await inviteAgent();

      const row = await systemPrisma.invite.findFirstOrThrow({
        where: { tenantId: TENANT_A, email: INVITEE },
        select: { tokenHash: true },
      });
      const token = mailedToken();

      expect(row.tokenHash).toBe(hashAuthToken(token));
      expect(row.tokenHash).not.toContain(token);
    });

    it('reserves the address as an invited account with no password', async () => {
      const { created } = await inviteAgent();

      const user = await systemPrisma.user.findFirstOrThrow({
        where: { tenantId: TENANT_A, email: INVITEE },
        select: { status: true, passwordHash: true, role: true },
      });

      expect(created).toBe(true);
      expect(user).toEqual({ status: 'invited', passwordHash: null, role: 'agent' });
    });

    it('refreshes a lapsed invitation rather than refusing the address', async () => {
      const first = await inviteAgent();
      const firstToken = mailedToken();

      // Expire it the way seven quiet days would. The partial unique index has
      // no expiry term — Postgres requires an index predicate to be IMMUTABLE —
      // so this row still occupies it, which is exactly the trap the upsert is
      // there to avoid.
      await systemPrisma.invite.updateMany({
        where: { tenantId: TENANT_A, email: INVITEE },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const second = await asAdmin(TENANT_A, ADMIN_A, () =>
        invites.create({ email: INVITEE, role: 'supervisor', teamIds: [] }),
      );

      expect(first.created).toBe(true);
      // The same row, refreshed — a second live invitation for one address would
      // mean two accounts.
      expect(second.created).toBe(false);
      expect(second.invite.id).toBe(first.invite.id);
      expect(second.invite.role).toBe('supervisor');
      expect(mailedToken()).not.toBe(firstToken);

      const live = await systemPrisma.invite.count({
        where: { tenantId: TENANT_A, email: INVITEE, acceptedAt: null, revokedAt: null },
      });

      expect(live).toBe(1);
    });

    it('parks the teams on the invitation, not on the account', async () => {
      await inviteAgent('agent', [TEAM_A]);

      const [parked, joined] = await Promise.all([
        systemPrisma.inviteTeam.count({ where: { tenantId: TENANT_A, teamId: TEAM_A } }),
        systemPrisma.teamMember.count({ where: { tenantId: TENANT_A, teamId: TEAM_A } }),
      ]);

      expect(parked).toBe(1);
      expect(joined).toBe(0);
    });
  });

  describe('accepting one', () => {
    const acceptance = { displayName: 'Noor Sayed', password: PASSWORD };

    it('creates the account inside the inviting tenant, with the invited role', async () => {
      await inviteAgent('supervisor', [TEAM_A]);
      const token = mailedToken();

      const accepted = await asVisitor(TENANT_A, () =>
        invites.accept({ token, ...acceptance }, { ipAddress: null, userAgent: null }),
      );

      const user = await systemPrisma.user.findFirstOrThrow({
        where: { id: accepted.principal.userId },
        select: { tenantId: true, role: true, status: true, name: true, passwordHash: true },
      });

      expect(user.tenantId).toBe(TENANT_A);
      expect(user.role).toBe('supervisor');
      expect(user.status).toBe('active');
      expect(user.name).toBe('Noor Sayed');
      // Only a modern salted hash is present, which is TAR-35's criterion read
      // literally.
      expect(user.passwordHash).toContain('$argon2id$');
      expect(user.passwordHash).not.toContain(PASSWORD);
      await expect(new PasswordService().verify(String(user.passwordHash), PASSWORD)).resolves.toBe(
        true,
      );
    });

    it('joins the teams the invitation parked, and issues a session', async () => {
      await inviteAgent('agent', [TEAM_A]);

      const accepted = await asVisitor(TENANT_A, () =>
        invites.accept(
          { token: mailedToken(), ...acceptance },
          { ipAddress: null, userAgent: null },
        ),
      );

      const [membership, session] = await Promise.all([
        systemPrisma.teamMember.count({
          where: { tenantId: TENANT_A, teamId: TEAM_A, userId: accepted.principal.userId },
        }),
        systemPrisma.session.findFirstOrThrow({
          where: { id: accepted.principal.sessionId },
          select: { tenantId: true, userId: true, tokenHash: true, revokedAt: true },
        }),
      ]);

      expect(membership).toBe(1);
      expect(accepted.principal.teamIds).toEqual([TEAM_A]);
      expect(session.tenantId).toBe(TENANT_A);
      expect(session.userId).toBe(accepted.principal.userId);
      expect(session.revokedAt).toBeNull();
      // The cookie's value is never what the row holds.
      expect(session.tokenHash).toBe(hashSessionToken(accepted.sessionToken));
    });

    it('lets exactly one of two simultaneous acceptances win', async () => {
      await inviteAgent();
      const token = mailedToken();

      const outcomes = await Promise.allSettled([
        asVisitor(TENANT_A, () =>
          invites.accept({ token, ...acceptance }, { ipAddress: null, userAgent: null }),
        ),
        asVisitor(TENANT_A, () =>
          invites.accept({ token, ...acceptance }, { ipAddress: null, userAgent: null }),
        ),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

      const accounts = await systemPrisma.user.count({
        where: { tenantId: TENANT_A, email: INVITEE },
      });

      expect(accounts).toBe(1);
    });

    it('refuses a token that has already been used', async () => {
      await inviteAgent();
      const token = mailedToken();

      await asVisitor(TENANT_A, () =>
        invites.accept({ token, ...acceptance }, { ipAddress: null, userAgent: null }),
      );

      await expect(
        asVisitor(TENANT_A, () =>
          invites.accept({ token, ...acceptance }, { ipAddress: null, userAgent: null }),
        ),
      ).rejects.toMatchObject({ reason: 'consumed' });
    });

    it('refuses an expired token', async () => {
      await inviteAgent();
      const token = mailedToken();

      await systemPrisma.invite.updateMany({
        where: { tenantId: TENANT_A, email: INVITEE },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await expect(
        asVisitor(TENANT_A, () =>
          invites.accept({ token, ...acceptance }, { ipAddress: null, userAgent: null }),
        ),
      ).rejects.toMatchObject({ reason: 'expired' });
    });

    it('refuses a withdrawn token', async () => {
      const { invite } = await inviteAgent();
      const token = mailedToken();

      await asAdmin(TENANT_A, ADMIN_A, () => invites.revoke(invite.id));

      await expect(
        asVisitor(TENANT_A, () =>
          invites.accept({ token, ...acceptance }, { ipAddress: null, userAgent: null }),
        ),
      ).rejects.toMatchObject({ reason: 'revoked' });
    });
  });

  describe('tenant isolation', () => {
    it('does not let another tenant preview or redeem the token', async () => {
      await inviteAgent();
      const token = mailedToken();

      // Same token, presented at tenant B's address. Row-level security is what
      // refuses it — there is no tenant comparison in the service to forget.
      await expect(asVisitor(TENANT_B, () => invites.preview(token))).rejects.toMatchObject({
        reason: 'unknown',
      });

      await expect(
        asVisitor(TENANT_B, () =>
          invites.accept(
            { token, displayName: 'Impostor', password: PASSWORD },
            { ipAddress: null, userAgent: null },
          ),
        ),
      ).rejects.toBeInstanceOf(InviteTokenInvalidError);

      const leaked = await systemPrisma.user.count({ where: { tenantId: TENANT_B } });

      // Tenant B still has only its own fixture admin.
      expect(leaked).toBe(1);
    });

    it('does not let another tenant list, resend or withdraw the invitation', async () => {
      const { invite } = await inviteAgent();

      const seenByB = await asAdmin(TENANT_B, ADMIN_B, () => invites.list({ limit: 25 }));

      expect(seenByB.items).toEqual([]);

      await expect(
        asAdmin(TENANT_B, ADMIN_B, () => invites.resend(invite.id)),
      ).rejects.toMatchObject({ inviteId: invite.id });
      await expect(
        asAdmin(TENANT_B, ADMIN_B, () => invites.revoke(invite.id)),
      ).rejects.toMatchObject({ inviteId: invite.id });
    });
  });

  describe('the admin-facing list', () => {
    it('separates what is still usable from what has lapsed', async () => {
      await inviteAgent();

      const pending = await asAdmin(TENANT_A, ADMIN_A, () =>
        invites.list({ limit: 25, status: 'pending' }),
      );

      expect(pending.items.map((item) => item.email)).toEqual([INVITEE]);

      await systemPrisma.invite.updateMany({
        where: { tenantId: TENANT_A, email: INVITEE },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const [stillPending, expired] = await Promise.all([
        asAdmin(TENANT_A, ADMIN_A, () => invites.list({ limit: 25, status: 'pending' })),
        asAdmin(TENANT_A, ADMIN_A, () => invites.list({ limit: 25, status: 'expired' })),
      ]);

      expect(stillPending.items).toEqual([]);
      expect(expired.items.map((item) => item.email)).toEqual([INVITEE]);
    });

    it('never carries a token, in any field', async () => {
      await inviteAgent();
      const token = mailedToken();

      const page = await asAdmin(TENANT_A, ADMIN_A, () => invites.list({ limit: 25 }));

      expect(JSON.stringify(page)).not.toContain(token);
      expect(JSON.stringify(page)).not.toContain(hashAuthToken(token));
    });
  });
});

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Start the stack and apply the migrations first:\n` +
        '  pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login',
    );
  }

  return value;
}
