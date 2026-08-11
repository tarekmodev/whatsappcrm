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
 * ## Two layers, because neither one alone is enough
 *
 * **Per account, in Postgres.** `failed_login_attempts`, `last_failed_login_at`
 * and `locked_until` on `users`, written inside the login transaction. Durable
 * across a restart, filtered by RLS for free, auditable, and — the reason it is
 * not a Redis counter — readable by a tenant admin on `UserResponse.security`.
 * TAR-35 asks for a lockout that is *observable*, and a counter that vanishes
 * when a cache restarts cannot satisfy that.
 *
 * **Per address, in Redis.** A sliding window keyed by tenant *and* client
 * address. This is the only layer that can throttle an attacker spraying
 * addresses that have **no user row to count on**, which is what credential
 * stuffing actually looks like: ten thousand leaked email/password pairs tried
 * once each, never tripping any per-account threshold.
 *
 * ## Both keys carry the tenant
 *
 * `authfail:{tenantId}:{address}` and a per-user row that RLS already confines.
 * Tenant A's attacker therefore cannot lock out, or consume the allowance of,
 * tenant B's agents — TAR-59's fourth acceptance criterion, satisfied by the
 * shape of the key rather than by a check somebody has to remember to write.
 *
 * ## The address layer fails open, deliberately
 *
 * Every Redis path here degrades to a no-op when Redis is unreachable, so a
 * cache blip cannot lock an entire tenant out of signing in. What is left when
 * it does is the durable per-account lockout, which is the layer that protects
 * a real account. The reverse trade — failing closed — turns a dependency
 * outage into a total authentication outage, and it protects nothing that the
 * account counter does not already protect.
 *
 * ## …and it is off until the address means something
 *
 * `LOGIN_IP_THROTTLE_ENABLED` gates it, defaulting to off. Express `trust
 * proxy` is deliberately unset — `HostTenantGuard` needs `Host` to be
 * unforgeable — so behind a load balancer `request.ip` is the *proxy*, every
 * agent in a tenant shares one window, and twenty failures would lock the whole
 * tenant out for fifteen minutes. A control that is really a denial of service
 * is worse than no control, and the per-account lockout does not depend on it.
 */

/** One rejected credential attempt, as both layers need to see it. */
export interface FailedLoginAttempt {
  readonly tenantId: string;
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
   * Counts one rejected attempt in both layers.
   *
   * The account half runs first: it is the durable one, and it is the one whose
   * failure should surface. The address half is best-effort by construction.
   */
  async recordFailure(attempt: FailedLoginAttempt): Promise<void> {
    if (attempt.userId !== null) {
      await this.recordAccountFailure(attempt.userId);
    }

    await this.recordAddressFailure(attempt.tenantId, attempt.ipAddress);
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
