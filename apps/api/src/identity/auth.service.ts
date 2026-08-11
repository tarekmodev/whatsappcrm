import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUTH_POLICY,
  permissionsForRole,
  type LoginInput,
  type SessionPrincipal,
  type TenantRole,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { AccountLockedError, InvalidCredentialsError } from './identity.errors';
import { PasswordService } from './password.service';
import { SessionService, type IssuedSession } from './session.service';

/**
 * Login and logout (TAR-53, "flow contracts").
 *
 * ## The tenant is never in the request
 *
 * There is no tenant field in `LoginInput`, no header, no query parameter.
 * `HostTenantGuard` resolved the tenant from the request `Host` before this
 * service ran, and every statement below goes through `TenantPrisma` under that
 * scope. The consequence is the reason it is built this way: an unscoped
 * `user.findUnique({ where: { email } })` would return the *first* matching row
 * across all tenants — email is unique per tenant, not globally — so somebody
 * with accounts at two client organisations would sign into whichever row the
 * planner happened to return. Under RLS that query is structurally incapable of
 * it, rather than relying on a filter nobody forgot to write.
 *
 * ## What login refuses to tell you
 *
 * Unknown address, wrong password, an invited account that has never set one,
 * and a suspended or removed user all answer `invalid_credentials`, with the
 * same body and in comparable time — the last part is what
 * `PasswordService.verifyDummy` buys, and without it the response *timing*
 * re-opens the enumeration the identical bodies were there to close.
 *
 * A locked account answers 429 rather than a code of its own, because a code
 * only a real account can produce confirms the address exists.
 */

/** What the login read needs from `users`, and nothing more. */
interface LoginCandidateRow {
  id: string;
  password_hash: string | null;
  status: string;
  role: TenantRole;
  email: string;
  name: string;
  locked: boolean;
  lock_seconds_remaining: number;
  team_ids: string[];
}

export interface LoginContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface LoginResult {
  readonly principal: SessionPrincipal;
  readonly issued: IssuedSession;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Authenticates an email and password against the tenant in scope, and issues
   * a session.
   *
   * The successful path is one transaction: the lockout counters reset,
   * `last_login_at` is stamped, the password is re-hashed if the policy has
   * moved on, and the session row is inserted — together, or not at all. A
   * session that exists while the counters still say the account is locked is a
   * half-applied login, and there is no obvious moment to notice it.
   */
  async login(input: LoginInput, context: LoginContext): Promise<LoginResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const candidate = await this.findCandidate(input.email);

    if (candidate === null || candidate.password_hash === null || candidate.status !== 'active') {
      // Burn a verify's worth of CPU so this answer is not measurably faster
      // than a wrong password. Logged without the address: a log of attempted
      // addresses is PII and a target in its own right.
      await this.passwords.verifyDummy(input.password);
      this.logger.warn(`Login refused for tenant ${tenantId}: no account able to sign in.`);
      throw new InvalidCredentialsError();
    }

    if (candidate.locked) {
      // No password verification at all. Verifying would let an attacker keep
      // testing guesses through a lockout and learn the answer from the timing.
      throw new AccountLockedError(candidate.lock_seconds_remaining);
    }

    if (!(await this.passwords.verify(candidate.password_hash, input.password))) {
      await this.recordFailure(candidate.id);
      throw new InvalidCredentialsError();
    }

    return await this.issueSession(tenantId, candidate, input.password, context);
  }

  /**
   * Ends the caller's session, or every session they hold.
   *
   * Always succeeds, including when the session was already gone: a logout that
   * can fail is a logout button that sometimes leaves people signed in. The
   * cookie is cleared by the controller regardless of what happened here.
   */
  async logout(principal: SessionPrincipal, allSessions: boolean): Promise<void> {
    const revoked = await this.prisma.$tenantTransaction(async (tx) => {
      if (allSessions) {
        return await this.sessions.revokeAllForUser(
          tx,
          principal.tenantId,
          principal.userId,
          'logout_all',
        );
      }

      const tokenHash = await this.sessions.revokeOne(
        tx,
        principal.tenantId,
        principal.userId,
        principal.sessionId,
        'logout',
      );

      return tokenHash === null ? 0 : 1;
    });

    // Unconditional, and after the commit. Purging a cache entry that did not
    // need purging costs one Postgres read on the next request; missing one
    // that did would leave a revoked session answering for up to a minute.
    await this.sessions.purgeCacheFor(principal.tenantId, principal.userId);

    this.logger.log(
      `Signed out user ${principal.userId} (${revoked} session${revoked === 1 ? '' : 's'} revoked).`,
    );
  }

  /**
   * The candidate row, read under RLS so it can only ever be one from the
   * tenant in scope.
   *
   * `locked` and `lock_seconds_remaining` are computed by **Postgres**, against
   * its own `now()`. Comparing `locked_until` to a Node process's clock would
   * let skew between two API replicas end a lockout early on one of them, which
   * is the replica an attacker would find.
   */
  private async findCandidate(email: string): Promise<LoginCandidateRow | null> {
    const [row] = await this.prisma.$queryRaw<LoginCandidateRow[]>`
      SELECT u.id,
             u.password_hash,
             u.status::text AS status,
             u.role::text   AS role,
             u.email::text  AS email,
             u.name,
             (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
             GREATEST(COALESCE(EXTRACT(EPOCH FROM (u.locked_until - now())), 0), 0)::int
                            AS lock_seconds_remaining,
             COALESCE(
               (SELECT array_agg(tm.team_id::text)
                  FROM team_members tm
                 WHERE tm.tenant_id = u.tenant_id AND tm.user_id = u.id),
               ARRAY[]::text[]
             )              AS team_ids
        FROM users u
       WHERE u.email = ${email}::citext
    `;

    return row ?? null;
  }

  /**
   * Counts one failed attempt, and locks the account on every positive multiple
   * of the threshold.
   *
   * Every multiple, not only the first: an attacker who waits out one window
   * would otherwise get a fresh allowance of ten guesses for every fifteen
   * minutes they are willing to spend. The counter is reset only by a
   * successful login (or by TAR-59's admin unlock).
   *
   * The whole decision is one statement, so two concurrent failed attempts
   * cannot both read "nine" and both write "ten".
   */
  private async recordFailure(userId: string): Promise<void> {
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

  /** The success path: reset, stamp, upgrade the hash if due, insert the session. */
  private async issueSession(
    tenantId: string,
    candidate: LoginCandidateRow,
    plaintext: string,
    context: LoginContext,
  ): Promise<LoginResult> {
    // Computed before the transaction, because argon2id at these parameters
    // takes ~100 ms and holding a database connection open across it would put
    // the pool at the mercy of the hash rate.
    const rehashed = this.passwords.needsRehash(candidate.password_hash ?? '')
      ? await this.passwords.hash(plaintext)
      : null;

    const issued = await this.prisma.$tenantTransaction(async (tx) => {
      await resetLoginState(tx, candidate.id, rehashed);

      return await this.sessions.issue(tx, {
        tenantId,
        userId: candidate.id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
    });

    const principal: SessionPrincipal = {
      userId: candidate.id,
      tenantId,
      email: candidate.email,
      displayName: candidate.name,
      role: candidate.role,
      permissions: [...permissionsForRole(candidate.role)],
      teamIds: candidate.team_ids,
      sessionId: issued.sessionId,
      expiresAt: issued.expiresAt.toISOString(),
    };

    // After the commit: a cached principal for a transaction that rolled back
    // would be a live credential for a session that does not exist.
    await this.sessions.publish(issued, principal);

    this.logger.log(`Signed in user ${candidate.id} in tenant ${tenantId}.`);

    return { principal, issued };
  }
}

/**
 * Clears the lockout state and stamps the login, in the same commit as the
 * session insert.
 *
 * `lastSeenAt` is set here as well as `lastLoginAt`: signing in *is* being
 * seen, and the people list renders the denormalised column. Leaving it to the
 * session-touch path would show somebody who logged in a minute ago as never
 * seen for the first five.
 */
async function resetLoginState(
  tx: Prisma.TransactionClient,
  userId: string,
  rehashed: string | null,
): Promise<void> {
  const now = new Date();

  await tx.user.update({
    where: { id: userId },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: now,
      lastSeenAt: now,
      ...(rehashed === null ? {} : { passwordHash: rehashed }),
    },
    select: { id: true },
  });
}
