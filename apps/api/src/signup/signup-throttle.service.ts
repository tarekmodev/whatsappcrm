import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SIGNUP_POLICY } from '@whatsappcrm/contracts';
import { AuthRedisClient } from '../identity/auth-redis.client';
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
 * ## Fail open, deliberately
 *
 * A Redis outage lets signups through rather than stopping them, the same call
 * `LoginThrottleService` makes. The counters bound abuse; they are not the thing
 * that keeps a signup from becoming a tenant — verification is. Failing closed
 * would turn a cache outage into "nobody can sign up", which is a worse day than
 * an hour without a rate limit.
 */
@Injectable()
export class SignupThrottleService {
  private readonly logger = new Logger(SignupThrottleService.name);

  constructor(private readonly redis: AuthRedisClient) {}

  /**
   * Refuses a signup or resend that has spent either allowance.
   *
   * Called **before** the slug lookup and before the password is hashed, so a
   * blocked caller costs one Redis round trip rather than a database read and an
   * argon2id verify — which is what stops a flood from turning into a CPU denial
   * of service on the hash.
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
