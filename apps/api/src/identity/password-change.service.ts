import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PasswordChangeInput } from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { SessionRevocationService } from '../rbac/session-revocation.service';
import { CurrentPasswordIncorrectError } from './identity.errors';
import { LoginThrottleService } from './login-throttle.service';
import { MAILER, type MailerPort } from './mailer/mailer.port';
import { PasswordService } from './password.service';

/**
 * `POST /api/v1/auth/password` — changing your own password while signed in
 * (TAR-57).
 *
 * The account is always the caller's own. There is no user id in the route, the
 * body or anywhere else: it is read from the principal the guard resolved, so
 * there is no parameter an attacker could point at somebody else's credentials.
 *
 * `currentPassword` is required even though the caller already holds a valid
 * session, and that is the design decision worth defending: a session cookie
 * proves the browser has a cookie, not that the person at the keyboard is the
 * account holder. Without it, one unlocked laptop is a permanent account
 * takeover — the attacker sets a password only they know and every session
 * except theirs is then revoked by this same endpoint.
 */
@Injectable()
export class PasswordChangeService {
  private readonly logger = new Logger(PasswordChangeService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    @Inject(MAILER) private readonly mailer: MailerPort,
    private readonly passwords: PasswordService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly sessions: SessionRevocationService,
    private readonly loginThrottle: LoginThrottleService,
  ) {}

  async change(input: PasswordChangeInput): Promise<void> {
    const principal = this.tenantContext.requirePrincipal();
    const tenantId = this.tenantContext.requireTenantId();

    const account = await this.prisma.user.findUnique({
      where: { id: principal.userId },
      // The one query in this module that reads `password_hash`, and it reads
      // nothing else it does not need.
      select: { passwordHash: true, email: true },
    });

    // A null hash is an invited account that never accepted, which cannot hold a
    // session — so this is a broken state rather than a normal one. Answered
    // identically to a wrong password all the same: this endpoint is reachable
    // by anyone holding a session cookie, and a different answer here would be a
    // fact about the account.
    if (account === null || account.passwordHash === null) {
      throw new CurrentPasswordIncorrectError();
    }

    if (!(await this.passwords.verify(account.passwordHash, input.currentPassword))) {
      throw new CurrentPasswordIncorrectError();
    }

    // Outside the transaction: argon2id is deliberately expensive and must not
    // hold a pooled connection open while it runs.
    const passwordHash = await this.passwords.hash(input.newPassword);

    const sessionsRevoked = await this.prisma.$tenantTransaction(async (tx) => {
      await tx.user.update({
        where: { id: principal.userId },
        data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
        select: { id: true },
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.passwordChanged,
        targetType: 'user',
        targetId: principal.userId,
      });

      // Every session except this one. Killing the others is what makes a
      // password change useful after a suspected compromise; killing this one
      // too would sign the user out of the tab they just used, which reads as a
      // failure rather than as a security measure.
      return await this.sessions.revokeFor(
        tx,
        tenantId,
        principal.userId,
        'password_change',
        principal.sessionId,
      );
    });

    // The after-commit half of the revocation, as above. It evicts the caller's
    // own cache entry too, which is correct and cheap: their session row was
    // deliberately spared, so their next request re-reads it from Postgres and
    // carries on. Leaving the *other* devices cached is the failure that
    // matters — a password change made after a suspected compromise would keep
    // the attacker signed in for another `sessionCacheTtlMs`.
    await this.sessions.purgeCacheFor(tenantId, principal.userId);

    // The Redis half of the lockout clear inside the transaction, kept in step
    // with it: the two counters that can refuse this address are cleared
    // together everywhere, or the invariant is one somebody has to remember.
    await this.loginThrottle.clearEmailFailures(tenantId, account.email);

    this.logger.log(`Password changed; ${sessionsRevoked} other session(s) revoked.`);

    try {
      await this.mailer.send({
        to: account.email,
        template: 'password_changed',
        tenantId,
        data: {},
      });
    } catch (error: unknown) {
      // The password is already changed and committed. Failing the request now
      // would tell the caller their change did not happen, and they would try
      // again with a "current password" that is no longer current.
      this.logger.error(
        `Could not send the password_changed email for tenant ${tenantId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
