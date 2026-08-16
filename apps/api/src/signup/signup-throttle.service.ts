import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SIGNUP_POLICY } from '@whatsappcrm/contracts';
import { AuthRedisClient } from '../identity/auth-redis.client';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import { SignupRateLimitedError } from './signup.errors';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The abuse controls on the four public signup routes (TAR-405, 0009 decision 3).
 *
 * These endpoints are the most exposed in the product — outside tenancy, with no
 * session and no credential of any kind — so a rate limit is not a nicety here,
 * it is what stands in for authentication. Three counters, each answering a
 * different abuse:
 *
 *   * **Per address, per hour.** One machine enumerating slugs or minting
 *     signups. A person signs up once; five allows a shared office NAT and a
 *     couple of mistakes.
 *   * **Per email, per day.** The form is an unauthenticated way to make us send
 *     mail to an address the sender does not control, so this is the one that
 *     bounds mailbox flooding — the same job `resetRequestsPerEmailPerHour` does
 *     for password reset.
 *   * **Slug checks per address, per minute.** The form checks as the user
 *     types. A debounce backstop rather than a security control: the answer is
 *     already public in DNS.
 *
 * ## Keys carry no tenant, and the email is hashed
 *
 * Every other throttle in the product is keyed by tenant, because every other
 * one runs inside one. There is no tenant here, so these are platform-wide
 * counters — which is also the point, since what they bound is somebody creating
 * tenants.
 *
 * The address is hashed into the key rather than written into it, matching
 * `LoginThrottleService`: Redis keys turn up in `MONITOR` output, in slow-log
 * entries and in a memory dump, and an unverified email address sitting in one
 * is a personal detail nobody has confirmed and no user agreed to have stored
 * there.
 *
 * ## What happens when Redis is unavailable
 *
 * The Redis windows fail **open**, the same call `LoginThrottleService` makes:
 * failing closed would turn a cache outage into "nobody can sign up", which is a
 * worse day than an hour of looser limits.
 *
 * What makes that safe here — and what login gets from its `users` columns — is
 * that the two signup-creating limits are **also** enforced against
 * `tenant_signups` itself, on every request, in the same Postgres the endpoint
 * already needs. An outage loosens the limits to whatever the durable layer
 * says; it does not remove them. `/signup` is never unbounded.
 *
 * `POST /signup/resend` needs its own answer, because it creates no row for
 * these counts to see. Its durable ceiling is `tenant_signups.resend_count`,
 * enforced inside the `UPDATE` in `TenantSignupService.resend` rather than here.
 * Between the two, verification mail to one address is capped at
 * `signupsPerEmailPerDay * (1 + resendsPerSignup)` a day with no cache involved.
 *
 * `assertMayCheckSlug` is the one that is Redis-only, and deliberately: an
 * availability check creates no row, so there is nothing durable to count. It is
 * a debounce backstop on an answer already public in DNS — losing it during an
 * outage costs nothing worth a second layer.
 */
@Injectable()
export class SignupThrottleService {
  private readonly logger = new Logger(SignupThrottleService.name);

  constructor(
    private readonly redis: AuthRedisClient,
    @Inject(SYSTEM_PRISMA) private readonly prisma: SystemPrisma,
  ) {}

  /**
   * Refuses a **signup** that has spent either allowance.
   *
   * **Two layers, and the second is why a Redis outage does not open the door.**
   * The Redis windows above are the cheap first line and they fail open, as
   * login's do. Behind them, `tenant_signups` is counted directly: those rows are
   * the thing a signup actually produces, they are in the same Postgres the rest
   * of the request needs anyway, and no cache outage can make them disappear.
   * This is the durable layer `LoginThrottleService` has in its `users` columns,
   * in the shape this table already supports.
   *
   * The two count different things, deliberately. Redis counts **attempts**,
   * including the ones that never became a row — a refused slug, a rejected
   * body — so it catches a caller hammering the endpoint without ever
   * succeeding. Postgres counts **rows created**, so it catches the same caller
   * after a cache restart wiped the window. Either can refuse on its own.
   *
   * Redis first, because a blocked caller should cost one round trip rather than
   * two database counts and an argon2id hash — which is what stops a flood from
   * becoming a CPU denial of service on the hasher.
   */
  async assertMayRequest(email: string, ipAddress: string | null): Promise<void> {
    await this.assertWithin(
      `signup:email:${hashed(email)}`,
      SIGNUP_POLICY.signupsPerEmailPerDay,
      DAY_MS,
      'signups for one address',
    );

    if (ipAddress !== null) {
      await this.assertWithin(
        `signup:ip:${hashed(ipAddress)}`,
        SIGNUP_POLICY.signupsPerIpPerHour,
        HOUR_MS,
        'signups from one client address',
      );
    }

    await this.assertRowsWithin(email, ipAddress);
  }

  /**
   * Refuses a **resend** that has spent its allowance.
   *
   * Its own per-email window rather than the signup one, and that is a fix
   * rather than a nicety: sharing `signup:email:` would let one signup plus two
   * resends exhaust the daily signup allowance, so `resendsPerSignup` could
   * never actually be reached and a customer who mistyped nothing would be told
   * to come back tomorrow. They are different actions — one claims a slug and
   * creates a row, the other re-sends mail about a row that already exists — and
   * they are counted separately.
   *
   * The per-address window **is** shared with signup, deliberately: an address
   * flooding the endpoint is the same abuse whichever route it uses, and it is
   * the client address rather than the action that identifies it.
   *
   * The durable half of this limit is not here. A resend writes no row for
   * `assertRowsWithin` to count, so its ceiling is `tenant_signups.resend_count`,
   * enforced inside the `UPDATE` in `TenantSignupService.resend`.
   */
  async assertMayResend(email: string, ipAddress: string | null): Promise<void> {
    // The **total** across every signup this address may hold, not the per-signup
    // ceiling: an address is allowed `signupsPerEmailPerDay` signups and each of
    // those may be re-sent `resendsPerSignup` times, so anything tighter here
    // would refuse a legitimate resend for a second signup and — worse — would
    // fire before `resend_count` ever bound anything, leaving the durable
    // ceiling unreachable and untested whenever Redis was up.
    //
    // So the two are layered rather than duplicated: this bounds the address,
    // `resend_count` bounds each signup.
    await this.assertWithin(
      `signup:resend:${hashed(email)}`,
      SIGNUP_POLICY.resendsPerSignup * SIGNUP_POLICY.signupsPerEmailPerDay,
      DAY_MS,
      'verification re-sends for one address',
    );

    if (ipAddress !== null) {
      await this.assertWithin(
        `signup:ip:${hashed(ipAddress)}`,
        SIGNUP_POLICY.signupsPerIpPerHour,
        HOUR_MS,
        'signup requests from one client address',
      );
    }
  }

  /**
   * The durable half: what `tenant_signups` says was actually created.
   *
   * Runs on every request, not only when Redis is unavailable — a fallback that
   * only engages during an outage is a fallback nobody exercises, and this one
   * costs two indexed counts on an endpoint that runs at human speed.
   *
   * **Counts by `created_at`, never by `expires_at`.** A row's creation time is
   * immutable; its expiry is not, and keying the window off a column a later
   * request can move would let a resend push its own record of itself out of the
   * window it is being measured against.
   *
   * A consumed row still counts. It is evidence that this address produced a
   * signup today, and exempting it would mean the fastest way to reset the
   * allowance is to complete a signup — which is precisely the loop this bounds.
   */
  private async assertRowsWithin(email: string, ipAddress: string | null): Promise<void> {
    const now = Date.now();

    const byEmail = await this.prisma.tenantSignup.count({
      where: { email, createdAt: { gt: new Date(now - DAY_MS) } },
    });

    if (byEmail >= SIGNUP_POLICY.signupsPerEmailPerDay) {
      this.refuse('signups recorded for one address', byEmail, SIGNUP_POLICY.signupsPerEmailPerDay);
    }

    if (ipAddress === null) {
      return;
    }

    const byAddress = await this.prisma.tenantSignup.count({
      where: { ipAddress, createdAt: { gt: new Date(now - HOUR_MS) } },
    });

    if (byAddress >= SIGNUP_POLICY.signupsPerIpPerHour) {
      this.refuse(
        'signups recorded from one client address',
        byAddress,
        SIGNUP_POLICY.signupsPerIpPerHour,
      );
    }
  }

  /** The availability check's own, much looser, allowance. */
  async assertMayCheckSlug(ipAddress: string | null): Promise<void> {
    if (ipAddress === null) {
      return;
    }

    await this.assertWithin(
      `signup:slugcheck:${hashed(ipAddress)}`,
      SIGNUP_POLICY.slugChecksPerIpPerMinute,
      MINUTE_MS,
      'slug availability checks',
    );
  }

  /**
   * A sliding window over a sorted set, scored by arrival time — the same shape
   * `LoginThrottleService` uses for its per-address counter, and sliding rather
   * than a fixed bucket for the same reason: a fixed bucket lets a caller spend
   * a full allowance either side of the boundary and get double the rate.
   *
   * The entry is added **before** the count is read, so this call is counted by
   * the decision it is making. Trimming on the same round trip is what stops the
   * set growing without bound for a caller who keeps trying.
   */
  private async assertWithin(
    key: string,
    limit: number,
    windowMs: number,
    what: string,
  ): Promise<void> {
    const now = Date.now();

    const count = await this.redis.run('signup throttle', async (client) => {
      const replies = await client
        .multi()
        .zremrangebyscore(key, '-inf', String(now - windowMs))
        // A unique member per attempt: two calls in the same millisecond must be
        // two entries, and a plain timestamp would collapse them into one.
        .zadd(key, String(now), `${now}:${Math.random().toString(36).slice(2)}`)
        .zcard(key)
        // Re-armed on every write, so the key disappears once a caller stops
        // rather than lingering at its original deadline.
        .pexpire(key, windowMs)
        .exec();

      return countAt(replies, 2);
    });

    // `null` is Redis being unreachable or unconfigured. Fail open — see above.
    if (count === null || count <= limit) {
      return;
    }

    this.refuse(what, count, limit);
  }

  /** One place the refusal is logged and raised, so both layers read alike. */
  private refuse(what: string, count: number, limit: number): never {
    this.logger.warn(`Refusing ${what}: ${count} within the window, limit ${limit}.`);

    throw new SignupRateLimitedError();
  }
}

/**
 * SHA-256, truncated to 32 hex characters. Long enough that a collision is not a
 * practical concern for a counter, short enough to keep the key small.
 */
function hashed(value: string): string {
  return createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 32);
}

/**
 * The count from one reply of a `MULTI`, or `null` if that command errored.
 *
 * ioredis returns `[error, value]` pairs, and a single failed command inside an
 * otherwise successful pipeline must read as "unknown" rather than as zero —
 * zero would silently reset the window on every partial failure.
 */
function countAt(replies: [Error | null, unknown][] | null, index: number): number | null {
  const reply = replies?.[index];

  if (reply === undefined || reply[0] !== null) {
    return null;
  }

  return typeof reply[1] === 'number' ? reply[1] : null;
}
