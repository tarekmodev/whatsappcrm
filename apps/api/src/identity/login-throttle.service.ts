import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_POLICY } from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { AUTH_KEY_PREFIX, AuthRedisClient } from './auth-redis.client';
import { TooManyAttemptsError } from './identity.errors';

/**
 * Brute-force protection for the login endpoint (TAR-53, decision 3).
 *
 * ## Three layers, because none of them alone is enough
 *
 * **Per account, in Postgres.** `failed_login_attempts`, `last_failed_login_at`
 * and `locked_until` on `users`, written inside the login transaction. Durable
 * across a restart, filtered by RLS for free, auditable, and — the reason it is
 * not a Redis counter — readable by a tenant admin on `UserResponse.security`.
 * TAR-35 asks for a lockout that is *observable*, and a counter that vanishes
 * when a cache restarts cannot satisfy that.
 *
 * **Per email address, in Redis.** The same threshold and the same lockout
 * duration as the account layer, counted against the address that was *typed*
 * rather than against a row. It exists because the account layer can only count
 * for an address that has one: with it alone, eleven wrong passwords answer 429
 * for a real account and 401 for an address with no account, and the difference
 * is a per-tenant user-enumeration oracle that the identical bodies and the
 * dummy verify were there to close. Mirroring the numbers is what makes the two
 * cases indistinguishable — see `assertEmailWithinLimit`.
 *
 * **Per client address, in Redis.** A sliding window keyed by tenant *and*
 * client address, at a higher threshold. This is the layer that catches one
 * attacker spraying *many* addresses — ten thousand leaked email/password pairs
 * tried once each, never tripping any single-address threshold.
 *
 * ## Every key carries the tenant
 *
 * `authfail:{tenantId}:{address}`, `emailfail:{tenantId}:{emailHash}`,
 * `emaillock:{tenantId}:{emailHash}`, and a per-user row that RLS already
 * confines. Tenant A's attacker therefore cannot lock out, or consume the
 * allowance of, tenant B's agents — TAR-59's fourth acceptance criterion,
 * satisfied by the shape of the key rather than by a check somebody has to
 * remember to write.
 *
 * ## The Redis layers fail open, deliberately
 *
 * Every Redis path here degrades to a no-op when Redis is unreachable, so a
 * cache blip cannot lock an entire tenant out of signing in. What is left when
 * it does is the durable per-account lockout, which is the layer that protects
 * a real account. The reverse trade — failing closed — turns a dependency
 * outage into a total authentication outage, and it protects nothing that the
 * account counter does not already protect.
 *
 * The cost of that choice is stated rather than hidden: while Redis is down the
 * enumeration oracle the email layer closes is open again, because the only
 * remaining producer of a 429 on login is a real account's lockout. It is a
 * degraded mode, it is logged, and it is the same trade every other Redis path
 * in this module makes.
 *
 * ## …and the client-address layer is off until the address means something
 *
 * `LOGIN_IP_THROTTLE_ENABLED` gates **that layer only**, defaulting to off.
 * Express `trust proxy` is deliberately unset — `HostTenantGuard` needs `Host`
 * to be unforgeable — so behind a load balancer `request.ip` is the *proxy*,
 * every agent in a tenant shares one window, and twenty failures would lock the
 * whole tenant out for fifteen minutes. A control that is really a denial of
 * service is worse than no control.
 *
 * The email layer carries no such flag and needs none: the email comes from the
 * request body, so it identifies exactly one login attempt's target however
 * many proxies the request crossed. Nor does it add a denial of service — the
 * only thing an attacker can lock with it is an address they can already lock
 * durably through the account layer, at the same threshold.
 */

/** One rejected credential attempt, as all three layers need to see it. */
export interface FailedLoginAttempt {
  readonly tenantId: string;
  /**
   * The address that was typed, whether or not it names an account. Counted for
   * both cases at the same threshold, which is what stops the lockout answering
   * "this account exists".
   */
  readonly email: string;
  /** `null` when the request carried no usable client address. */
  readonly ipAddress: string | null;
  /** `null` when the address matched no account able to sign in. */
  readonly userId: string | null;
}

@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);
  private readonly addressWindowEnabled: boolean;

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly redis: AuthRedisClient,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.addressWindowEnabled = config.get<boolean>('LOGIN_IP_THROTTLE_ENABLED') === true;

    if (!this.addressWindowEnabled) {
      this.logger.log(
        'LOGIN_IP_THROTTLE_ENABLED is off: brute-force protection is the per-account lockout ' +
          'only. Turn it on where request.ip is the client rather than a proxy.',
      );
    }
  }

  /**
   * Refuses the attempt outright when this address has already spent its
   * allowance against this tenant.
   *
   * Called **before** the account lookup, so a blocked address costs one Redis
   * round trip rather than a database read and an argon2id verify — which is
   * also what stops a spray from turning into a CPU denial of service on the
   * hash.
   */
  async assertAddressWithinLimit(tenantId: string, ipAddress: string | null): Promise<void> {
    if (ipAddress === null || !this.addressWindowEnabled) {
      return;
    }

    const key = addressKey(tenantId, ipAddress);
    const now = Date.now();

    const window = await this.redis.run('login throttle read', async (client) => {
      const replies = await client
        .multi()
        // Trim on read as well as on write: an address that stopped guessing
        // must not stay blocked by entries that have aged out of the window.
        .zremrangebyscore(key, '-inf', String(now - AUTH_POLICY.ipFailureWindowMs))
        .zcard(key)
        .zrange(key, '0', '0', 'WITHSCORES')
        .exec();

      return { failures: countAt(replies, 1), oldestAt: oldestScoreAt(replies, 2) };
    });

    // `null` is Redis being unreachable or unconfigured. Fail open — see the
    // class comment.
    if (window === null || window.failures < AUTH_POLICY.ipFailureThreshold) {
      return;
    }

    // The window clears when its oldest entry ages out, which is what makes it
    // sliding rather than a fixed bucket an attacker can straddle.
    const clearsAt = (window.oldestAt ?? now) + AUTH_POLICY.ipFailureWindowMs;

    this.logger.warn(
      `Refusing sign-in attempts from an address with ${window.failures} recent failures ` +
        `against tenant ${tenantId}.`,
    );

    throw new TooManyAttemptsError(secondsUntil(clearsAt, now));
  }

  /**
   * Refuses the attempt outright when the *typed address* has spent its
   * allowance against this tenant, whether or not it names an account.
   *
   * This is the layer that keeps the lockout from doubling as an
   * account-existence oracle. The per-account lockout can only count for an
   * address that has a row, so on its own it answers the eleventh wrong password
   * with 429 for a real account and 401 for an address with none — a difference
   * anyone can measure in eleven requests, and one that survives the identical
   * bodies and the dummy verify entirely. Counting the typed address at the same
   * threshold and for the same duration makes both cases answer the same
   * `rate_limited`, with a `Retry-After` computed the same way.
   *
   * Checked **before** the account lookup, so the two cases also cost the same:
   * a refusal here is one Redis round trip in both, rather than a lookup and an
   * argon2id verify in one of them.
   *
   * Fails open. Redis being unreachable puts the oracle back — see the class
   * comment — and that is the deliberate trade the whole module makes rather
   * than an oversight here.
   */
  async assertEmailWithinLimit(tenantId: string, email: string): Promise<void> {
    const lockedForMs = await this.redis.run(
      'login lockout read',
      async (client) => await client.pttl(emailLockKey(tenantId, email)),
    );

    // `null` is an unreachable Redis; a negative reply is "no such key" or "no
    // TTL". Only a live lock refuses.
    if (lockedForMs === null || lockedForMs <= 0) {
      return;
    }

    this.logger.warn(`Refusing a sign-in attempt against a locked address in tenant ${tenantId}.`);

    throw new TooManyAttemptsError(secondsUntil(Date.now() + lockedForMs, Date.now()));
  }

  /**
   * Counts one rejected attempt in every layer that can see it.
   *
   * The account half runs first: it is the durable one, and it is the one whose
   * failure should surface. The two Redis halves are best-effort by
   * construction.
   */
  async recordFailure(attempt: FailedLoginAttempt): Promise<void> {
    if (attempt.userId !== null) {
      await this.recordAccountFailure(attempt.userId);
    }

    await this.recordEmailFailure(attempt.tenantId, attempt.email);
    await this.recordAddressFailure(attempt.tenantId, attempt.ipAddress);
  }

  /**
   * Clears the email counter and lock.
   *
   * Called from the two places that clear `failed_login_attempts` for the same
   * reason, and it has to be both: a successful sign-in, because whoever just
   * proved they hold the password is not the attacker the counter was
   * accumulating against; and an admin unlock, because "let them back in now"
   * would otherwise mean "in up to fifteen minutes", refused by a layer no
   * admin can see. Neither hands an attacker anything the durable reset does
   * not already — that restores a full allowance of guesses by itself.
   *
   * The per-client-address window is deliberately *not* cleared by either. That
   * one belongs to whoever was guessing rather than to the account they were
   * guessing at, and clearing it would let an attacker restore their own
   * allowance by getting an admin to press a button.
   */
  async clearEmailFailures(tenantId: string, email: string): Promise<void> {
    await this.redis.run('login lockout clear', async (client) => {
      await client.del(emailFailureKey(tenantId, email), emailLockKey(tenantId, email));
    });
  }

  /**
   * Clears an account's lockout, for `POST /api/v1/users/{id}/unlock`.
   *
   * One conditional statement rather than a read and a write, so the return
   * value reports whether anything was actually cleared without a race: a
   * second unlock of an already-unlocked account writes nothing and is not
   * audited as if it had.
   *
   * It deliberately does **not** touch the address window. That window belongs
   * to whoever was guessing, not to the account they were guessing at, and
   * clearing it would let an attacker restore their own allowance by getting an
   * admin to unlock the account they just locked.
   */
  async clearAccountLock(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
    const cleared = await tx.user.updateMany({
      where: {
        id: userId,
        OR: [{ lockedUntil: { not: null } }, { failedLoginAttempts: { gt: 0 } }],
      },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    return cleared.count > 0;
  }

  /**
   * Counts one failed attempt against the account, and locks it on every
   * positive multiple of the threshold.
   *
   * Every multiple, not only the first: an attacker who waits out one window
   * would otherwise get a fresh allowance of ten guesses for every fifteen
   * minutes they are willing to spend. The counter is reset only by a
   * successful login or by an admin unlock.
   *
   * The whole decision is one statement, so two concurrent failed attempts
   * cannot both read "nine" and both write "ten".
   */
  private async recordAccountFailure(userId: string): Promise<void> {
    const lockedNow = await this.prisma.$tenantTransaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ failed_login_attempts: number; locked: boolean }[]>`
        UPDATE users
           SET failed_login_attempts = failed_login_attempts + 1,
               last_failed_login_at = now(),
               locked_until = CASE
                 WHEN (failed_login_attempts + 1) % ${AUTH_POLICY.loginFailureThreshold} = 0
                 THEN now() + make_interval(
                        secs => ${AUTH_POLICY.loginLockoutMs / 1_000}::double precision
                      )
                 ELSE locked_until
               END
         WHERE id = ${userId}::uuid
        RETURNING failed_login_attempts,
                  (locked_until IS NOT NULL AND locked_until > now()) AS locked
      `;

      if (row === undefined || !row.locked) {
        return false;
      }

      // One row per lockout, on the transition — see `AUDIT_ACTIONS.authLockout`.
      // No email address and no attempt count beyond the total, because this
      // table is exported for compliance review.
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.authLockout,
        targetType: 'user',
        targetId: userId,
        metadata: {
          failedAttempts: row.failed_login_attempts,
          lockoutMs: AUTH_POLICY.loginLockoutMs,
        },
      });

      return true;
    });

    if (lockedNow) {
      this.logger.warn(
        `Locked user ${userId} after ${AUTH_POLICY.loginFailureThreshold} failed sign-in attempts.`,
      );
    }
  }

  /**
   * Counts one failed attempt against the typed address, and locks it on every
   * positive multiple of the threshold.
   *
   * Deliberately the same threshold and the same duration as
   * `recordAccountFailure`, including the "every multiple" rule, because the
   * point of the layer is that the two are not tellable apart. Anywhere the
   * numbers diverge is a distinguisher, so they read from the same two
   * constants rather than from a pair of their own.
   *
   * The counter carries the lockout duration as its TTL rather than living
   * forever: an address nobody has guessed at for fifteen minutes is not worth
   * a Redis key, and the durable counter is what remembers the long history for
   * an address that has an account.
   */
  private async recordEmailFailure(tenantId: string, email: string): Promise<void> {
    const countKey = emailFailureKey(tenantId, email);

    const failures = await this.redis.run('login lockout write', async (client) => {
      const replies = await client
        .multi()
        .incr(countKey)
        .pexpire(countKey, AUTH_POLICY.loginLockoutMs)
        .exec();

      return countAt(replies, 0);
    });

    // `null` is an unreachable Redis and `0` an unreadable reply. Neither is a
    // count, and neither may be allowed to satisfy the modulo below — which `0`
    // otherwise would, locking an address on a failure nobody counted.
    if (failures === null || failures <= 0 || failures % AUTH_POLICY.loginFailureThreshold !== 0) {
      return;
    }

    await this.redis.run('login lockout set', async (client) => {
      await client.set(emailLockKey(tenantId, email), '1', 'PX', AUTH_POLICY.loginLockoutMs);
    });

    this.logger.warn(
      `Locked sign-in for an address in tenant ${tenantId} after ` +
        `${AUTH_POLICY.loginFailureThreshold} failed attempts.`,
    );
  }

  /**
   * Adds one entry to this address's window.
   *
   * Only reached for an attempt that got as far as being *rejected on its
   * credentials*: an attempt already refused by the window does not extend it,
   * so the set is bounded by the threshold rather than by how long an attacker
   * is willing to keep knocking.
   */
  private async recordAddressFailure(tenantId: string, ipAddress: string | null): Promise<void> {
    if (ipAddress === null || !this.addressWindowEnabled) {
      return;
    }

    const key = addressKey(tenantId, ipAddress);
    const now = Date.now();

    await this.redis.run('login throttle write', async (client) => {
      await client
        .multi()
        // The member has to be unique or two failures in the same millisecond
        // collapse into one entry, which would round an attacker's allowance up.
        .zadd(key, String(now), `${now}:${randomUUID()}`)
        .zremrangebyscore(key, '-inf', String(now - AUTH_POLICY.ipFailureWindowMs))
        // Refreshed on every write, so an address that stops guessing expires
        // one window later instead of being remembered forever.
        .pexpire(key, AUTH_POLICY.ipFailureWindowMs)
        .exec();
    });
  }
}

/**
 * The address is part of a Redis key, and behind a proxy it ultimately comes
 * from a header a client controls. Only a real IP literal is used verbatim;
 * anything else is hashed.
 *
 * Validate-or-hash rather than strip: stripping the characters an address is
 * not made of turns `203.0.113.7z` into `203.0.113.7`, which lets a forged
 * header spend — and therefore block — the window belonging to a *real*
 * neighbour. Hashing gives an unrecognisable value its own window, of fixed
 * length, with no separator to inject, and leaves the common case readable in
 * `redis-cli` where an operator wants it.
 */
function addressKey(tenantId: string, ipAddress: string): string {
  const label =
    isIP(ipAddress) === 0
      ? `sha256:${createHash('sha256').update(ipAddress, 'utf8').digest('hex').slice(0, 32)}`
      : ipAddress.toLowerCase();

  return `${AUTH_KEY_PREFIX}:authfail:${tenantId}:${label}`;
}

/**
 * The two email-scoped keys.
 *
 * The address is **always** hashed, never used verbatim the way an IP literal
 * is. Two reasons, and either alone would be enough: an email address is PII,
 * and `redis-cli KEYS` is not a place to keep a list of who has an account
 * here; and it is free text from a request body, so a verbatim key would let a
 * crafted address inject the `:` separator and reach another key.
 *
 * Lower-cased before hashing, because `users.email` is `citext` — `Ada@acme` and
 * `ada@acme` are one account, and two windows for one account would hand an
 * attacker twice the allowance for the price of a shift key.
 */
function emailFailureKey(tenantId: string, email: string): string {
  return `${AUTH_KEY_PREFIX}:emailfail:${tenantId}:${emailDigest(email)}`;
}

function emailLockKey(tenantId: string, email: string): string {
  return `${AUTH_KEY_PREFIX}:emaillock:${tenantId}:${emailDigest(email)}`;
}

function emailDigest(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 32);
}

/** Never zero: a `Retry-After: 0` invites an immediate retry. */
function secondsUntil(deadline: number, now: number): number {
  return Math.max(1, Math.ceil((deadline - now) / 1_000));
}

/**
 * ioredis reports a transaction as `[error, reply][]`, one pair per queued
 * command, or `null` when the whole `EXEC` was discarded. These two read one
 * position out of it and answer "no usable value" rather than throwing — the
 * caller's fallback for an unreadable window is the same as for an unreachable
 * Redis, so there is nothing a thrown error here could add.
 */
type PipelineReplies = [Error | null, unknown][] | null;

function countAt(replies: PipelineReplies, index: number): number {
  const value = replyAt(replies, index);

  return typeof value === 'number' ? value : 0;
}

/** `ZRANGE … WITHSCORES` answers `[member, score]`, with the score as a string. */
function oldestScoreAt(replies: PipelineReplies, index: number): number | null {
  const value = replyAt(replies, index);

  if (!Array.isArray(value)) {
    return null;
  }

  const score = Number(value[1]);

  return Number.isFinite(score) ? score : null;
}

function replyAt(replies: PipelineReplies, index: number): unknown {
  const reply = replies?.[index];

  return reply === undefined || reply[0] !== null ? undefined : reply[1];
}
