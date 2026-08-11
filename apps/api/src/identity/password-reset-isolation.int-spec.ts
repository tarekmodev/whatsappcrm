import type { ConfigService } from '@nestjs/config';
import type { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { SessionRevocationService } from '../rbac/session-revocation.service';
import { AuthRedisClient } from './auth-redis.client';
import { ResetTokenInvalidError } from './identity.errors';
import type { MailerPort, OutboundEmail } from './mailer/mailer.port';
import { PasswordResetService } from './password-reset.service';
import { PasswordService } from './password.service';
import { SessionCacheService } from './session-cache.service';
import { SessionService } from './session.service';

/**
 * The reset flow against real PostgreSQL, as `whatsappcrm_app` — the role that
 * holds no `BYPASSRLS`.
 *
 * A unit test can show the service composes the right statements. Only this can
 * show what TAR-57's riskiest claims actually depend on:
 *
 *   * **A reset token is worthless outside the tenant it was issued in.** Not
 *     because a comparison remembered to check `tenant_id`, but because the
 *     conditional `UPDATE` runs under a policy that makes the row invisible.
 *   * **Single-use survives concurrency.** Two redemptions of one link fired at
 *     the same moment: the second must find nothing. A read-then-write would
 *     pass a sequential test and fail this one.
 *   * **Expiry is the database's clock**, so a node with a skewed one cannot
 *     revive a dead token.
 *   * **A completed reset kills every session**, which is the criterion a mock
 *     session store would quietly satisfy without a row ever changing.
 *
 * ⚠️ It writes and commits. Two fixture tenants with fixed ids, removed before
 * the run as well as after it so an interrupted run cleans up on the next one.
 *
 * Prerequisites, as for every `*.int-spec.ts` here:
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '57555555-5555-7555-8555-555555555501';
const TENANT_B = '57555555-5555-7555-8555-555555555502';
const USER_A = '57555555-5555-7555-8555-5555555555a1';
const USER_B = '57555555-5555-7555-8555-5555555555b1';
const SESSION_A1 = '57555555-5555-7555-8555-55555555a101';
const SESSION_A2 = '57555555-5555-7555-8555-55555555a102';

const EMAIL = 'shared@example.invalid';
const NEW_PASSWORD = 'a replacement passphrase';
const REQUEST_ID = 'tar57-int-spec';

describe('password reset, against real Postgres', () => {
  const tenantContext = new TenantContextService();
  const passwords = new PasswordService();
  const sent: OutboundEmail[] = [];

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let resets: PasswordResetService;
  let redis: AuthRedisClient;
  let cache: SessionCacheService;

  const mailer: MailerPort = {
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  };

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null, principal: null },
      async () => await work(),
    );
  }

  /** The token that was mailed — the only place a plaintext token exists. */
  async function requestFor(tenantId: string): Promise<string> {
    sent.length = 0;
    await asTenant(tenantId, () => resets.request({ email: EMAIL }, '203.0.113.9'));

    const token = sent.at(-1)?.data.token;

    if (token === undefined) {
      throw new Error('no reset email was produced');
    }

    return token;
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.session.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.passwordResetToken.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.auditLog.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.user.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    const audit = {
      record: () => Promise.resolve(),
    } as unknown as AuditService;

    const config = {
      get: (key: string) => (key === 'REDIS_URL' ? process.env.REDIS_URL : undefined),
    } as unknown as ConfigService;

    redis = new AuthRedisClient(config);
    cache = new SessionCacheService(redis);

    resets = new PasswordResetService(
      tenantPrisma,
      mailer,
      passwords,
      tenantContext,
      audit,
      new SessionRevocationService(audit, new SessionService(tenantPrisma, cache)),
    );

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar57-fixture-a', name: 'TAR-57 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar57-fixture-b', name: 'TAR-57 fixture B', status: 'active' },
      ],
    });

    // The same address in both tenants — identity is tenant-scoped, so this is a
    // supported state and exactly the one a cross-tenant bug would surface in.
    await systemPrisma.user.createMany({
      data: [
        {
          id: USER_A,
          tenantId: TENANT_A,
          email: EMAIL,
          name: 'Agent A',
          status: 'active',
          passwordHash: await passwords.hash('the original passphrase'),
        },
        {
          id: USER_B,
          tenantId: TENANT_B,
          email: EMAIL,
          name: 'Agent B',
          status: 'active',
          passwordHash: await passwords.hash('the original passphrase'),
        },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await redis.onApplicationShutdown();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await systemPrisma.passwordResetToken.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.session.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
  });

  it('issues the token against the tenant the request host resolved, and no other', async () => {
    await requestFor(TENANT_A);

    const rows = await systemPrisma.passwordResetToken.findMany({
      select: { tenantId: true, userId: true },
    });

    expect(rows).toEqual([{ tenantId: TENANT_A, userId: USER_A }]);
  });

  it('refuses a tenant A token presented at tenant B, and leaves B untouched', async () => {
    const token = await requestFor(TENANT_A);

    await expect(
      asTenant(TENANT_B, () => resets.confirm({ token, password: NEW_PASSWORD })),
    ).rejects.toBeInstanceOf(ResetTokenInvalidError);

    // Indistinguishable from a token that never existed: RLS makes the row
    // invisible, so there is nothing to classify it as anything else.
    await expect(
      asTenant(TENANT_B, () => resets.confirm({ token, password: NEW_PASSWORD })),
    ).rejects.toMatchObject({ reason: 'unknown' });

    const [a, b] = await Promise.all([
      systemPrisma.user.findUniqueOrThrow({
        where: { id: USER_A },
        select: { passwordHash: true },
      }),
      systemPrisma.user.findUniqueOrThrow({
        where: { id: USER_B },
        select: { passwordHash: true },
      }),
    ]);

    await expect(passwords.verify(a.passwordHash ?? '', NEW_PASSWORD)).resolves.toBe(false);
    await expect(passwords.verify(b.passwordHash ?? '', NEW_PASSWORD)).resolves.toBe(false);

    // And the token is still live for its own tenant — the wrong-tenant attempt
    // must not have consumed it.
    await expect(
      asTenant(TENANT_A, () => resets.confirm({ token, password: NEW_PASSWORD })),
    ).resolves.toBeUndefined();
  });

  it('sets the new password and revokes every session for that user only', async () => {
    await systemPrisma.session.createMany({
      data: [SESSION_A1, SESSION_A2].map((id, index) => ({
        id,
        tenantId: TENANT_A,
        userId: USER_A,
        tokenHash: `tar57-session-${index}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 86_400_000),
      })),
    });

    const token = await requestFor(TENANT_A);
    await asTenant(TENANT_A, () => resets.confirm({ token, password: NEW_PASSWORD }));

    const user = await systemPrisma.user.findUniqueOrThrow({
      where: { id: USER_A },
      select: { passwordHash: true, failedLoginAttempts: true, lockedUntil: true },
    });

    await expect(passwords.verify(user.passwordHash ?? '', NEW_PASSWORD)).resolves.toBe(true);
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.lockedUntil).toBeNull();

    // Soft revoke since TAR-56: the row survives so the trail can say why every
    // session for one person died at once, and every read path filters
    // `revoked_at IS NULL`. "Still live" is what has to be zero, not "still
    // present".
    const sessions = await systemPrisma.session.findMany({
      select: { id: true, revokedAt: true, revokedReason: true },
    });

    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
    expect(sessions.map((session) => session.revokedReason)).toEqual([
      'password_reset',
      'password_reset',
    ]);
  });

  it('is single-use: a second redemption of the same link finds nothing', async () => {
    const token = await requestFor(TENANT_A);

    await asTenant(TENANT_A, () => resets.confirm({ token, password: NEW_PASSWORD }));

    await expect(
      asTenant(TENANT_A, () => resets.confirm({ token, password: 'yet another passphrase' })),
    ).rejects.toMatchObject({ reason: 'consumed' });
  });

  it('is single-use under concurrency, which is what the conditional UPDATE is for', async () => {
    const token = await requestFor(TENANT_A);

    const outcomes = await Promise.allSettled([
      asTenant(TENANT_A, () => resets.confirm({ token, password: NEW_PASSWORD })),
      asTenant(TENANT_A, () => resets.confirm({ token, password: 'a different passphrase' })),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    // Exactly one of the two passwords won, rather than one overwriting the other.
    const user = await systemPrisma.user.findUniqueOrThrow({
      where: { id: USER_A },
      select: { passwordHash: true },
    });
    await expect(passwords.verify(user.passwordHash ?? '', NEW_PASSWORD)).resolves.toBe(true);
  });

  it('refuses an expired token, judged by the database clock', async () => {
    const token = await requestFor(TENANT_A);

    await systemPrisma.passwordResetToken.updateMany({
      where: { tenantId: TENANT_A },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(
      asTenant(TENANT_A, () => resets.confirm({ token, password: NEW_PASSWORD })),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it('invalidates the previous link when a new one is requested', async () => {
    const first = await requestFor(TENANT_A);
    const second = await requestFor(TENANT_A);

    expect(second).not.toBe(first);

    await expect(
      asTenant(TENANT_A, () => resets.confirm({ token: first, password: NEW_PASSWORD })),
    ).rejects.toMatchObject({ reason: 'consumed' });

    await expect(
      asTenant(TENANT_A, () => resets.confirm({ token: second, password: NEW_PASSWORD })),
    ).resolves.toBeUndefined();
  });

  it('never stores the token itself, only its hash', async () => {
    const token = await requestFor(TENANT_A);

    const rows = await systemPrisma.passwordResetToken.findMany({
      select: { tokenHash: true },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(token);
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('says nothing about an address with no account in this tenant', async () => {
    sent.length = 0;

    await expect(
      asTenant(TENANT_A, () => resets.request({ email: 'nobody@example.invalid' }, null)),
    ).resolves.toBeUndefined();

    expect(sent).toHaveLength(0);
    expect(await systemPrisma.passwordResetToken.count()).toBe(0);
  });
});

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
