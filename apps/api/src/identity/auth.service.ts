import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  TENANT_STATUS_EFFECTS,
  permissionsForRole,
  type LoginInput,
  type SessionPrincipal,
  type TenantRole,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { AccountLockedError, InvalidCredentialsError } from './identity.errors';
import { LoginThrottleService } from './login-throttle.service';
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
 * only a real account can produce confirms the address exists. The status alone
 * is not enough, though: a 429 that *only* a real account can reach is the same
 * oracle wearing a different hat, which is why the throttle locks the typed
 * address at the same threshold whether or not it names one. The two cases
 * differ in nothing a caller can see — not the code, not the body, not the
 * order of the checks, and not the work done before the answer.
 *
 * ## Brute-force protection lives next door
 *
 * `LoginThrottleService` owns all three counters — the durable per-account one,
 * the per-email lockout and the per-client-address window in Redis. This
 * service decides *whether* an attempt failed; that one decides what a run of
 * failures costs.
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
    private readonly throttle: LoginThrottleService,
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

    // Both before the lookup and before the hash: an attempt that has spent its
    // allowance costs one Redis round trip, not a query and ~100 ms of argon2id.
    //
    // The email check runs for every address, not only the ones with an account
    // — that is what stops the refusal itself from being the answer to "does
    // this address exist here".
    await this.throttle.assertAddressWithinLimit(tenantId, context.ipAddress);
    await this.throttle.assertEmailWithinLimit(tenantId, input.email);

    const candidate = await this.findCandidate(input.email);

    if (candidate === null || candidate.password_hash === null || candidate.status !== 'active') {
      // Burn a verify's worth of CPU so this answer is not measurably faster
      // than a wrong password. Logged without the address: a log of attempted
      // addresses is PII and a target in its own right.
      await this.passwords.verifyDummy(input.password);
      // Counted too, with no user to count against. This is the case the two
      // Redis layers exist for — spraying leaked pairs at addresses that have
      // no row here would otherwise be free, and an address that never locks is
      // an address an attacker can tell apart from one that does.
      await this.throttle.recordFailure({
        tenantId,
        userId: null,
        email: input.email,
        ipAddress: context.ipAddress,
      });
      this.logger.warn(`Login refused for tenant ${tenantId}: no account able to sign in.`);
      throw new InvalidCredentialsError();
    }

    if (candidate.locked) {
      // No password verification at all. Verifying would let an attacker keep
      // testing guesses through a lockout and learn the answer from the timing.
      //
      // Not counted either, in either layer: the attempt was refused on a
      // decision already made, and counting it would let a locked-out user's
      // own retries burn the allowance their office shares.
      throw new AccountLockedError(candidate.lock_seconds_remaining);
    }

    if (!(await this.passwords.verify(candidate.password_hash, input.password))) {
      await this.throttle.recordFailure({
        tenantId,
        userId: candidate.id,
        email: input.email,
        ipAddress: context.ipAddress,
      });
      throw new InvalidCredentialsError();
    }

    this.assertTenantAdmitsRole(candidate.role);

    return await this.issueSession(tenantId, candidate, input.password, context);
  }

  /**
   * The lifecycle half of login, and **the order it runs in is the security
   * property** (ADR 0009 decision 2).
   *
   * TAR-36 says a suspended tenant's agents cannot log in. A blanket refusal
   * would lock the admin out too, and reactivation at v1 is driven by a payment
   * webhook or an operator — neither of which an admin can trigger from outside
   * the product. So a `suspended` or `cancelled` tenant admits an `admin` to a
   * session, confined afterwards by `TenantStatusGuard`'s recovery allowlist,
   * and refuses an `agent` or a `supervisor` outright.
   *
   * This runs **after** the entire authentication flow — the IP window, the
   * lockout, the user lookup, the fixed dummy verify on a miss, and the real
   * verify — and not before. Checking the status first would turn the endpoint
   * into a role oracle: an unauthenticated caller could learn, per email
   * address, whether that address is an admin of the tenant, by watching which
   * of two errors comes back. Authenticating first means the answer only differs
   * for somebody who already holds the password.
   *
   * It reads the status `HostTenantGuard` resolved rather than issuing its own
   * query, and it reads `TENANT_STATUS_EFFECTS` rather than restating which
   * states are closed — the contract's table is the one the console renders
   * against, and a second copy here is one that drifts from it.
   *
   * A queue worker or a fixture reaching this code has no status in scope, and
   * that reads as "no lifecycle objection". It is not a hole: nothing calls
   * `login` outside a request, and `PrincipalGuard` plus `TenantStatusGuard`
   * stand between any session it issues and every route.
   */
  private assertTenantAdmitsRole(role: TenantRole): void {
    const status = this.tenantContext.tenantStatus;

    if (status === null || TENANT_STATUS_EFFECTS[status].apiAccess || role === 'admin') {
      return;
    }

    this.logger.warn(
      `Login refused for a ${role} of a ${status} tenant: only an administrator may sign in to ` +
        'restore it.',
    );

    throw new TenantNotActiveError(this.tenantContext.requireTenantId(), 'login');
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

    // The Redis mirror of `resetLoginState` zeroing the durable counter in the
    // transaction above. Whoever just proved they hold the password is not the
    // attacker those failures were accumulating against, and nine left on the
    // key would lock them out on their next typo. Keyed by the stored address
    // rather than the typed one — `citext` makes them the same account, and the
    // key is derived from a lower-cased digest either way.
    await this.throttle.clearEmailFailures(tenantId, candidate.email);

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
