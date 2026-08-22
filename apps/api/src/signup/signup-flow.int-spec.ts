import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ConfigService } from '@nestjs/config';
import { LIFECYCLE_POLICY, SIGNUP_POLICY, type OutboundEmail } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { AuthRedisClient } from '../identity/auth-redis.client';
import { PasswordService } from '../identity/password.service';
import { SessionCacheService } from '../identity/session-cache.service';
import { hashSessionToken } from '../identity/session-token';
import { SessionService } from '../identity/session.service';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { QueueService } from '../queue/queue.service';
import { TenantLifecycleNotifier } from '../tenancy/lifecycle/tenant-lifecycle.notifier';
import { TenantLifecycleService } from '../tenancy/lifecycle/tenant-lifecycle.service';
import { TenantProvisioningService } from '../tenancy/tenant-provisioning.service';
import { SignupThrottleService } from './signup-throttle.service';
import {
  SignupRateLimitedError,
  SignupTokenInvalidError,
  SlugUnavailableError,
} from './signup.errors';
import { TenantSignupService } from './tenant-signup.service';

/**
 * Self-signup end to end against a real PostgreSQL (TAR-405).
 *
 * What lives here rather than in a unit spec, because a fake cannot prove any of
 * it:
 *
 *   * **A visitor reaches a working tenant with no operator action** — the
 *     acceptance criterion, run for real: form, mail, click, provisioned tenant,
 *     first admin, session.
 *   * **The tenant starts on trial**, in `trialing` with the trial caps, and can
 *     immediately read its own rows — which only holds because
 *     `assert_tenant_active` admits `trialing`. A tenant provisioned into a
 *     status the database gate refuses would be a workspace that 403s on its
 *     first query, and nothing but a real connection catches that.
 *   * **A link is single-use**, because the conditional `UPDATE` says so and not
 *     because anything checked first.
 *   * **The slug reservation is a partial unique index**, including the part
 *     Prisma cannot express — that an expired reservation releases the name.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Fixture rows are
 * removed before the run as well as after it, so an interrupted run cleans up on
 * the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const FIXTURE_PREFIX = 'tar405-signup';
const SLUG = 'tar405-signup-fixture';
const OTHER_SLUG = 'tar405-signup-other';
const EMAIL = 'founder@tar405-signup.invalid';
const PASSWORD = 'a-perfectly-adequate-password';

const REQUEST_ID = 'tar405-signup-int-spec';
const ORIGIN = { ipAddress: null, userAgent: null };

const DAY_MS = 24 * 60 * 60 * 1000;

describe('public self-signup', () => {
  const tenantContext = new TenantContextService();
  const mailbox: OutboundEmail[] = [];

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let signup: TenantSignupService;
  let redis: AuthRedisClient;
  let notifier: TenantLifecycleNotifier;

  /**
   * The lifecycle service signup hands the genesis event to, with **no Redis**:
   * every enqueue answers `unavailable`, the row still commits with
   * `notified_at IS NULL`, and in production the sweep is what would pick it up.
   * A supported state rather than a stub, and it keeps the welcome-email
   * assertion below about the mapping and the recipients — which is where
   * TAR-598's bug was — rather than about BullMQ.
   */
  function lifecycleWithoutQueue(): TenantLifecycleService {
    return new TenantLifecycleService(
      systemPrisma,
      new QueueService({ get: () => undefined } as unknown as ConfigService, tenantContext),
    );
  }

  /** The token as it left in the email — the only place the plaintext exists. */
  function mailedToken(): string {
    return String(mailbox.at(-1)?.data.token);
  }

  function signupInput(overrides: Partial<Record<string, string>> = {}) {
    return {
      email: EMAIL,
      password: PASSWORD,
      adminName: 'Ada Founder',
      tenantName: 'TAR-405 Fixture',
      slug: SLUG,
      ...overrides,
    };
  }

  /**
   * By prefix rather than by an exact list: the Redis-outage block below claims a
   * slug per request to reach the per-address allowance, so the set of names this
   * file touches is not fixed.
   */
  async function removeFixture(): Promise<void> {
    await systemPrisma.tenantSignup.deleteMany({
      where: { desiredSlug: { startsWith: FIXTURE_PREFIX } },
    });
    // Users, sessions, domains and the limits row all cascade from the tenant.
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
  }

  beforeAll(() => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);
    redis = new AuthRedisClient({
      get: (key: string) => (key === 'REDIS_URL' ? process.env.REDIS_URL : undefined),
    } as unknown as ConfigService);

    const config = {
      get: (key: string) => configValue(key),
      getOrThrow: (key: string) => {
        const value = configValue(key);

        if (value === undefined) {
          throw new Error(`${key} is not configured in this fixture.`);
        }

        return value;
      },
    } as unknown as ConfigService;

    const mailer = {
      send: (message: OutboundEmail) => {
        mailbox.push(message);
        return Promise.resolve();
      },
    };

    const lifecycle = lifecycleWithoutQueue();

    // The worker the queue would have run, driven directly by the tests that
    // care what the genesis row sends.
    notifier = new TenantLifecycleNotifier(systemPrisma, mailer);

    signup = new TenantSignupService(
      systemPrisma,
      mailer,
      new TenantProvisioningService(systemPrisma, lifecycle, config),
      lifecycle,
      new PasswordService(),
      new SessionService(tenantPrisma, new SessionCacheService(redis), new EventEmitter2()),
      new SignupThrottleService(redis, systemPrisma),
      config,
    );
  });

  afterAll(async () => {
    await removeFixture();
    await redis.onApplicationShutdown();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    mailbox.length = 0;
    await removeFixture();
    // The throttle is platform-wide and keyed by hashed email, so counters left
    // by an earlier test would refuse this one's third signup. Scoped to this
    // suite's own keys rather than `flushdb`: the suites share one Redis, and
    // wiping it would take another suite's sessions with it.
    await redis.run('clear signup throttle', async (client) => {
      const keys = await client.keys('signup:*');

      return keys.length === 0 ? 0 : client.del(...keys);
    });
  });

  describe('requesting a signup', () => {
    it('provisions nothing and mails a link', async () => {
      const accepted = await signup.request(signupInput(), null);

      expect(accepted.email).toBe(EMAIL);
      await expect(systemPrisma.tenant.count({ where: { slug: SLUG } })).resolves.toBe(0);

      const [mail] = mailbox;

      expect(mail?.template).toBe('signup_verification');
      // No tenant to name, which is what tells the adapter to put the link on the
      // platform host rather than looking one up.
      expect(mail?.tenantId).toBeNull();
      expect(mailedToken()).not.toBe('');
    });

    /** The plaintext exists in the email and nowhere else — not in the row. */
    it('stores only the digest of the token', async () => {
      await signup.request(signupInput(), null);

      const row = await systemPrisma.tenantSignup.findFirstOrThrow({
        where: { desiredSlug: SLUG },
        select: { tokenHash: true, passwordHash: true },
      });

      expect(row.tokenHash).not.toBe(mailedToken());
      expect(row.tokenHash).not.toContain(mailedToken());
      // And the password is hashed before it is stored, at argon2id's own prefix.
      expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
    });

    it('refuses a slug an unconsumed signup is already holding', async () => {
      await signup.request(signupInput(), null);

      await expect(
        signup.request(signupInput({ email: 'someone-else@tar405-signup.invalid' }), null),
      ).rejects.toThrow(SlugUnavailableError);
    });

    it('refuses a slug a provisioned tenant already has', async () => {
      await signup.request(signupInput(), null);
      await signup.verify(mailedToken(), ORIGIN);

      await expect(
        signup.request(signupInput({ email: 'later@tar405-signup.invalid' }), null),
      ).rejects.toThrow(SlugUnavailableError);
    });

    /**
     * The partial unique index cannot carry `AND expires_at > now()` — an index
     * predicate must be IMMUTABLE — so an abandoned signup would hold its slug
     * for ever if nothing removed it. The insert path's delete is what stands in
     * for the term the index cannot have.
     */
    it('releases a slug whose reservation has lapsed', async () => {
      await signup.request(signupInput(), null);

      await systemPrisma.tenantSignup.updateMany({
        where: { desiredSlug: SLUG },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        signup.request(signupInput({ email: 'second@tar405-signup.invalid' }), null),
      ).resolves.toMatchObject({ email: 'second@tar405-signup.invalid' });
    });
  });

  describe('verifying', () => {
    it('provisions a trialing tenant whose first admin is the person who signed up', async () => {
      await signup.request(signupInput(), null);

      const completed = await signup.verify(mailedToken(), ORIGIN);

      expect(completed.tenant.slug).toBe(SLUG);
      expect(completed.tenant.status).toBe('trialing');
      expect(completed.principal.role).toBe('admin');
      expect(completed.principal.email).toBe(EMAIL);

      const admin = await systemPrisma.user.findFirstOrThrow({
        where: { tenantId: completed.tenant.id },
        select: { email: true, role: true, status: true, name: true },
      });

      expect(admin).toEqual({
        email: EMAIL,
        role: 'admin',
        status: 'active',
        name: 'Ada Founder',
      });
    });

    /**
     * TAR-598. `tenant_welcome` is mapped in `TenantLifecycleNotifier` and was
     * unreachable in production: the notifier only sends off a committed
     * `lifecycle_events` row, and provisioning wrote none — so a tenant's trail
     * started empty and its first admin never got a welcome.
     *
     * The queue is the one link this does not exercise (there is no Redis here),
     * and it is the link the other nine templates already share. What is asserted
     * is the part that was broken: that the row exists, says what it should, and
     * addresses the notice to the admin the signup just created.
     */
    it('writes a genesis lifecycle row that welcomes the new admin', async () => {
      await signup.request(signupInput(), null);
      const completed = await signup.verify(mailedToken(), ORIGIN);

      const events = await systemPrisma.lifecycleEvent.findMany({
        where: { tenantId: completed.tenant.id },
        select: {
          id: true,
          fromState: true,
          toState: true,
          trigger: true,
          actorType: true,
          occurredAt: true,
          notifiedAt: true,
        },
      });

      expect(events).toHaveLength(1);
      const [genesis] = events;

      expect(genesis).toMatchObject({
        fromState: null,
        toState: 'trialing',
        trigger: 'system',
        actorType: 'system',
        // Nothing has sent it yet, which is what leaves it for the queue — or,
        // if the queue is down, for the sweep's backstop.
        notifiedAt: null,
      });

      mailbox.length = 0;
      await notifier.notify(genesis?.id ?? '');

      expect(mailbox).toHaveLength(1);
      expect(mailbox[0]).toMatchObject({
        template: 'tenant_welcome',
        to: EMAIL,
        tenantId: completed.tenant.id,
      });

      // Claimed, so a redelivery cannot mail the same admin twice.
      await expect(
        systemPrisma.lifecycleEvent.findUniqueOrThrow({
          where: { id: genesis?.id ?? '' },
          select: { notifiedAt: true },
        }),
      ).resolves.toMatchObject({ notifiedAt: expect.any(Date) as Date });

      mailbox.length = 0;
      await notifier.notify(genesis?.id ?? '');
      expect(mailbox).toHaveLength(0);
    });

    it('starts the trial clock from the published policy', async () => {
      await signup.request(signupInput(), null);
      const before = Date.now();

      const completed = await signup.verify(mailedToken(), ORIGIN);

      const tenant = await systemPrisma.tenant.findUniqueOrThrow({
        where: { id: completed.tenant.id },
        select: { trialEndsAt: true },
      });
      const expected = before + LIFECYCLE_POLICY.trialDays * DAY_MS;

      expect(tenant.trialEndsAt).not.toBeNull();
      // A minute of slack for the round trip; the point is the span, not the ms.
      expect(Math.abs((tenant.trialEndsAt?.getTime() ?? 0) - expected)).toBeLessThan(60_000);
    });

    /**
     * AC 3, and the half of it a unit test cannot reach: the entitlements
     * enforcement reads have to be the trial's, and they have to be readable *by
     * the tenant*, on the connection that is subject to RLS.
     */
    it('puts the tenant on the trial entitlements, readable through TenantPrisma', async () => {
      await signup.request(signupInput(), null);
      const completed = await signup.verify(mailedToken(), ORIGIN);

      const [row] = await tenantContext.run(
        { requestId: REQUEST_ID, tenantId: completed.tenant.id, userId: null, principal: null },
        () =>
          tenantPrisma.$tenantTransaction((tx) =>
            tx.tenantEntitlements.findMany({
              select: { planKey: true, planName: true, entitlements: true },
            }),
          ),
      );

      expect(row).toMatchObject({ planKey: 'trial', planName: 'Trial' });
      // The limits themselves are the column default — 0009's published trial
      // shape, deliberately not restated by provisioning — so this is also what
      // pins them, and what would fail if the default drifted from the contract.
      expect(row?.entitlements).toMatchObject({
        limits: { seats: 3, conversationsPerPeriod: 1000 },
      });
    });

    it('issues a session the new admin is signed in with', async () => {
      await signup.request(signupInput(), null);

      const completed = await signup.verify(mailedToken(), ORIGIN);

      const session = await systemPrisma.session.findFirstOrThrow({
        where: { tenantId: completed.tenant.id },
        select: { tokenHash: true, userId: true },
      });

      expect(session.tokenHash).toBe(hashSessionToken(completed.sessionToken));
      expect(session.userId).toBe(completed.principal.userId);
    });

    /** The conditional `UPDATE` is the guarantee, not a read that preceded it. */
    it('refuses a link that has already been spent', async () => {
      await signup.request(signupInput(), null);
      const token = mailedToken();

      await signup.verify(token, ORIGIN);

      await expect(signup.verify(token, ORIGIN)).rejects.toThrow(SignupTokenInvalidError);
      // And exactly one tenant came out of it, not two.
      await expect(systemPrisma.tenant.count({ where: { slug: SLUG } })).resolves.toBe(1);
    });

    it('refuses a lapsed link, and provisions nothing', async () => {
      await signup.request(signupInput(), null);

      await systemPrisma.tenantSignup.updateMany({
        where: { desiredSlug: SLUG },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(signup.verify(mailedToken(), ORIGIN)).rejects.toThrow(SignupTokenInvalidError);
      await expect(systemPrisma.tenant.count({ where: { slug: SLUG } })).resolves.toBe(0);
    });

    it('refuses a token nobody was issued', async () => {
      await expect(signup.verify('a'.repeat(43), ORIGIN)).rejects.toThrow(SignupTokenInvalidError);
    });

    /**
     * Two clicks on one link, at once. Exactly one may provision — the other has
     * to lose on the `UPDATE` rather than race it to the slug's unique index,
     * which would surface as a 500 on a link somebody double-clicked.
     */
    it('lets only one of two simultaneous clicks through', async () => {
      await signup.request(signupInput(), null);
      const token = mailedToken();

      const outcomes = await Promise.allSettled([
        signup.verify(token, ORIGIN),
        signup.verify(token, ORIGIN),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

      const [refused] = outcomes.filter((outcome) => outcome.status === 'rejected');

      expect(refused?.reason).toBeInstanceOf(SignupTokenInvalidError);
      await expect(systemPrisma.tenant.count({ where: { slug: SLUG } })).resolves.toBe(1);
    });

    /** Forensics, and the constraint that a row naming a tenant is also consumed. */
    it('records which tenant the signup produced', async () => {
      await signup.request(signupInput(), null);
      const completed = await signup.verify(mailedToken(), ORIGIN);

      const row = await systemPrisma.tenantSignup.findFirstOrThrow({
        where: { desiredSlug: SLUG },
        select: { consumedAt: true, provisionedTenantId: true },
      });

      expect(row.consumedAt).not.toBeNull();
      expect(row.provisionedTenantId).toBe(completed.tenant.id);
    });
  });

  describe('resending', () => {
    it('issues a new link and kills the old one', async () => {
      await signup.request(signupInput(), null);
      const first = mailedToken();

      await signup.resend(EMAIL, null);
      const second = mailedToken();

      expect(second).not.toBe(first);
      await expect(signup.verify(first, ORIGIN)).rejects.toThrow(SignupTokenInvalidError);
      await expect(signup.verify(second, ORIGIN)).resolves.toMatchObject({
        tenant: { slug: SLUG },
      });
    });

    /**
     * The deadline belongs to the signup, not to the last email about it.
     * Extending it per resend would make the window renewable at one request a
     * day — and because the slug reservation rides on `expires_at`, an address
     * could hold a name indefinitely without ever verifying. That is the bound
     * 0009 decision 3 puts on a reservation, so the column must not move.
     */
    it('rotates the token without moving the deadline', async () => {
      await signup.request(signupInput(), null);

      const before = await systemPrisma.tenantSignup.findFirstOrThrow({
        where: { desiredSlug: SLUG },
        select: { expiresAt: true, tokenHash: true },
      });

      const accepted = await signup.resend(EMAIL, null);

      const after = await systemPrisma.tenantSignup.findFirstOrThrow({
        where: { desiredSlug: SLUG },
        select: { expiresAt: true, tokenHash: true },
      });

      expect(after.tokenHash).not.toBe(before.tokenHash);
      expect(after.expiresAt.toISOString()).toBe(before.expiresAt.toISOString());
      // And the caller is told the real deadline rather than a recomputed one.
      expect(accepted.expiresAt.toISOString()).toBe(before.expiresAt.toISOString());
    });

    /**
     * The consequence of the rule above, stated as a test so nobody "fixes" it:
     * a signup near its deadline cannot resend its way past it. The route out is
     * a fresh signup, which the expiry sweep has by then made possible.
     */
    it('cannot extend a reservation that is about to lapse', async () => {
      await signup.request(signupInput(), null);

      const nearlyDone = new Date(Date.now() + 2_000);

      await systemPrisma.tenantSignup.updateMany({
        where: { desiredSlug: SLUG },
        data: { expiresAt: nearlyDone },
      });

      await signup.resend(EMAIL, null);

      const after = await systemPrisma.tenantSignup.findFirstOrThrow({
        where: { desiredSlug: SLUG },
        select: { expiresAt: true },
      });

      expect(after.expiresAt.toISOString()).toBe(nearlyDone.toISOString());
    });

    /**
     * An address with nothing outstanding gets no mail and the same answer as one
     * that had. Anything else is an oracle for which addresses have signed up.
     */
    it('says nothing about an address that never signed up', async () => {
      await expect(signup.resend('stranger@tar405-signup.invalid', null)).resolves.toMatchObject({
        email: 'stranger@tar405-signup.invalid',
      });

      expect(mailbox).toHaveLength(0);
    });

    /**
     * One address can legitimately hold two live signups — the slug reservation
     * is unique per slug, not per email — and an unbounded `WHERE email = $1`
     * would write the same `token_hash` to both and trip `tenant_signups_token`.
     * That is a 500 on a route an anonymous caller can reach at will.
     */
    it('rotates exactly one row when the address has two signups in flight', async () => {
      await signup.request(signupInput(), null);
      await signup.request(signupInput({ slug: OTHER_SLUG }), null);

      await expect(signup.resend(EMAIL, null)).resolves.toMatchObject({ email: EMAIL });

      const rows = await systemPrisma.tenantSignup.findMany({
        where: { email: EMAIL },
        select: { desiredSlug: true, resendCount: true },
        orderBy: { id: 'asc' },
      });

      // The newest — the one the person most likely means, and whose reservation
      // has longest to run. The older one is untouched.
      expect(rows).toEqual([
        { desiredSlug: SLUG, resendCount: 0 },
        { desiredSlug: OTHER_SLUG, resendCount: 1 },
      ]);
    });

    /**
     * A resend writes no new row, so the durable row counts cannot see one. Its
     * ceiling lives on the row instead — otherwise this route mails an unverified
     * address without limit for as long as Redis is unreachable.
     */
    it('stops re-sending once the signup has spent its resends', async () => {
      await signup.request(signupInput(), null);

      for (let n = 0; n < SIGNUP_POLICY.resendsPerSignup; n += 1) {
        await signup.resend(EMAIL, null);
      }

      const sentSoFar = mailbox.length;

      // Same 202, no mail: a distinct answer here would confirm the address has a
      // signup in flight.
      await expect(signup.resend(EMAIL, null)).resolves.toMatchObject({ email: EMAIL });
      expect(mailbox).toHaveLength(sentSoFar);

      const row = await systemPrisma.tenantSignup.findFirstOrThrow({
        where: { desiredSlug: SLUG },
        select: { resendCount: true },
      });

      expect(row.resendCount).toBe(SIGNUP_POLICY.resendsPerSignup);
    });

    /**
     * The ceiling has to hold under concurrency, and only a real database shows
     * whether it does.
     *
     * Under READ COMMITTED the second `UPDATE` blocks on the row lock, then
     * re-evaluates its own `WHERE` against the committed row — but only the
     * *outer* clause. With the guard inside the uncorrelated sub-`SELECT` that
     * recheck saw `id = <constant>`, still true, and both requests incremented:
     * the count landed one past the ceiling and a second email went out. With
     * the guard in the outer clause the loser matches nothing.
     */
    it('does not let two concurrent resends step over the ceiling', async () => {
      await signup.request(signupInput(), null);

      // One short of the ceiling, so exactly one of the two below may win.
      await systemPrisma.tenantSignup.updateMany({
        where: { desiredSlug: SLUG },
        data: { resendCount: SIGNUP_POLICY.resendsPerSignup - 1 },
      });

      mailbox.length = 0;

      await Promise.all([signup.resend(EMAIL, null), signup.resend(EMAIL, null)]);

      const row = await systemPrisma.tenantSignup.findFirstOrThrow({
        where: { desiredSlug: SLUG },
        select: { resendCount: true },
      });

      expect(row.resendCount).toBe(SIGNUP_POLICY.resendsPerSignup);
      // And exactly one of the two actually mailed anything.
      expect(mailbox).toHaveLength(1);
    });

    /** And the link from the last permitted resend still works. */
    it('leaves the last issued link usable after the ceiling is reached', async () => {
      await signup.request(signupInput(), null);

      for (let n = 0; n < SIGNUP_POLICY.resendsPerSignup; n += 1) {
        await signup.resend(EMAIL, null);
      }

      const last = mailedToken();

      await signup.resend(EMAIL, null);

      await expect(signup.verify(last, ORIGIN)).resolves.toMatchObject({ tenant: { slug: SLUG } });
    });
  });

  /**
   * The layer that has to hold when the cache does not.
   *
   * `SignupThrottleService`'s Redis windows fail open, as login's do — so on
   * their own a Redis outage would leave `/signup` completely unbounded. These
   * cases run the throttle with **no Redis at all** and assert the limits are
   * still enforced, because the second layer counts `tenant_signups` rows in the
   * same Postgres the endpoint already needs.
   */
  describe('with Redis unavailable', () => {
    let offline: TenantSignupService;

    beforeAll(() => {
      // A client pointed at nothing: `AuthRedisClient.run` answers null, which is
      // exactly what it answers during a real outage.
      const deadRedis = new AuthRedisClient({
        get: () => undefined,
      } as unknown as ConfigService);

      const config = {
        get: (key: string) => configValue(key),
        getOrThrow: (key: string) => configValue(key),
      } as unknown as ConfigService;

      const lifecycle = lifecycleWithoutQueue();

      offline = new TenantSignupService(
        systemPrisma,
        {
          send: (message: OutboundEmail) => {
            mailbox.push(message);
            return Promise.resolve();
          },
        },
        new TenantProvisioningService(systemPrisma, lifecycle, config),
        lifecycle,
        new PasswordService(),
        new SessionService(tenantPrisma, new SessionCacheService(deadRedis), new EventEmitter2()),
        new SignupThrottleService(deadRedis, systemPrisma),
        config,
      );
    });

    it('still bounds signups for one address', async () => {
      // Each takes a different slug, so what refuses the last one is the
      // per-email allowance rather than the reservation.
      for (let n = 0; n < SIGNUP_POLICY.signupsPerEmailPerDay; n += 1) {
        await offline.request(signupInput({ slug: `${OTHER_SLUG}-${n}` }), null);
      }

      await expect(
        offline.request(signupInput({ slug: `${OTHER_SLUG}-over` }), null),
      ).rejects.toThrow(SignupRateLimitedError);
    });

    it('still bounds signups from one client address', async () => {
      const address = '203.0.113.7';

      for (let n = 0; n < SIGNUP_POLICY.signupsPerIpPerHour; n += 1) {
        await offline.request(
          signupInput({ email: `ip-${n}@tar405-signup.invalid`, slug: `${OTHER_SLUG}-ip-${n}` }),
          address,
        );
      }

      await expect(
        offline.request(
          signupInput({ email: 'ip-over@tar405-signup.invalid', slug: `${OTHER_SLUG}-ip-over` }),
          address,
        ),
      ).rejects.toThrow(SignupRateLimitedError);
    });

    /**
     * A consumed signup still counts. Exempting it would make completing a
     * signup the fastest way to reset the allowance, which is the loop this
     * bounds in the first place.
     */
    it('counts a signup that has already been verified', async () => {
      await offline.request(signupInput(), null);
      await offline.verify(mailedToken(), ORIGIN);

      for (let n = 1; n < SIGNUP_POLICY.signupsPerEmailPerDay; n += 1) {
        await offline.request(signupInput({ slug: `${OTHER_SLUG}-${n}` }), null);
      }

      await expect(
        offline.request(signupInput({ slug: `${OTHER_SLUG}-after` }), null),
      ).rejects.toThrow(SignupRateLimitedError);
    });
  });

  describe('slug availability', () => {
    it('is free before anybody asks for it', async () => {
      await expect(signup.slugAvailability(SLUG, null)).resolves.toEqual({
        slug: SLUG,
        available: true,
      });
    });

    it('is taken while a signup is holding it', async () => {
      await signup.request(signupInput(), null);

      await expect(signup.slugAvailability(SLUG, null)).resolves.toMatchObject({
        available: false,
      });
    });

    it('is taken once a tenant has it', async () => {
      await signup.request(signupInput(), null);
      await signup.verify(mailedToken(), ORIGIN);

      await expect(signup.slugAvailability(SLUG, null)).resolves.toMatchObject({
        available: false,
      });
    });
  });
});

/** The fixture's configuration, matching what `envShape` would have produced. */
function configValue(key: string): string | boolean | undefined {
  switch (key) {
    case 'PLATFORM_DOMAIN':
      return 'app.localhost';
    case 'APP_LINK_SCHEME':
      return 'http';
    case 'SIGNUP_ENABLED':
      return true;
    default:
      return undefined;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Run the suite through \`pnpm test:db\` with the stack up: ` +
        'pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login',
    );
  }

  return value;
}
