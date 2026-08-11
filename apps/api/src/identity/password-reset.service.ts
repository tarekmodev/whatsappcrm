import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUTH_POLICY,
  type PasswordResetConfirmInput,
  type PasswordResetRequestInput,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { SessionRevocationService } from '../rbac/session-revocation.service';
import { ResetTokenInvalidError, type TokenRejectionReason } from './identity.errors';
import { LoginThrottleService } from './login-throttle.service';
import { MAILER, RESET_PASSWORD_LINK_PATH, type MailerPort } from './mailer/mailer.port';
import { PasswordService } from './password.service';
import { hashResetToken, issueResetToken } from './reset-token';

/** How far back the per-account request throttle counts. */
const THROTTLE_WINDOW_MS = 60 * 60 * 1000;

/**
 * What redeeming a token did, so the caller can raise the right failure *after*
 * the transaction has committed rather than by rolling it back.
 *
 * That distinction is the point of this type. A token presented by somebody who
 * may no longer sign in has still been spent, and throwing inside the
 * transaction would roll the `consumed_at` back and leave the link live for the
 * next attempt.
 */
type Redemption =
  | { readonly outcome: 'not-redeemable' }
  | { readonly outcome: 'owner-inactive' }
  | {
      readonly outcome: 'reset';
      readonly userId: string;
      readonly email: string;
      readonly sessionsRevoked: number;
    };

/**
 * Forgotten-password recovery (TAR-57): request a link, redeem it once.
 *
 * Everything runs on `TenantPrisma` with the tenant resolved from the request
 * host, so a reset is structurally incapable of reaching another tenant's user —
 * the same token hash presented at the wrong tenant's domain matches zero rows
 * because RLS filters it, not because a check remembered to compare a column.
 *
 * Two properties are worth reading the code for, because they are what the
 * acceptance criteria actually turn on:
 *
 *   * **Single-use is the `UPDATE`, not a read followed by a write.** One
 *     conditional statement flips `consumed_at` and returns the row it flipped;
 *     two concurrent redemptions of the same link mean the second one updates
 *     nothing. A read-then-write would let both through and set the password
 *     twice — from two different requests.
 *   * **Every expiry comparison is the database's `now()`.** API instances do
 *     not share a clock, and a node running two minutes fast would otherwise
 *     resurrect a token the database considers dead.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    @Inject(MAILER) private readonly mailer: MailerPort,
    private readonly passwords: PasswordService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly sessions: SessionRevocationService,
    private readonly loginThrottle: LoginThrottleService,
  ) {}

  /**
   * `POST /api/v1/auth/password-reset`. Resolves whatever happened — the caller
   * answers 204 unconditionally.
   *
   * **Nothing about the outcome reaches the caller**, including the throttle.
   * Reporting "too many requests" would confirm the address has an account, which
   * reinstates precisely the enumeration oracle the unconditional 204 exists to
   * close, and the throttle's job — stopping somebody using the reset form to
   * flood a real mailbox — does not need the sender to be told.
   *
   * Users who are `invited`, `suspended` or `removed` get no email. An invited
   * user's route in is their invite, not a reset for a password they never set.
   */
  async request(input: PasswordResetRequestInput, requestedIp: string | null): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();

    const user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: input.email } },
      select: { id: true, email: true, name: true, status: true },
    });

    if (user === null || user.status !== 'active') {
      // Never the address: a log of attempted emails is PII and a target in its
      // own right (TAR-53, what is logged).
      this.logger.debug('Password reset requested for an address with no active account.');
      return;
    }

    if (await this.isThrottled(user.id)) {
      this.logger.warn(
        `Password reset throttled for user ${user.id}: more than ` +
          `${AUTH_POLICY.resetRequestsPerEmailPerHour} requests in the last hour.`,
      );
      return;
    }

    const { token, tokenHash } = issueResetToken();
    const expiresAt = new Date(Date.now() + AUTH_POLICY.passwordResetTtlMs);

    await this.prisma.$tenantTransaction(async (tx) => {
      // A new link invalidates the old one, so a reset email forwarded or
      // screenshotted before this one stops working the moment it is superseded.
      await tx.passwordResetToken.updateMany({
        where: { tenantId, userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      await tx.passwordResetToken.create({
        data: { tenantId, userId: user.id, tokenHash, expiresAt, requestedIp },
        select: { id: true },
      });
    });

    await this.send({
      to: user.email,
      template: 'password_reset',
      tenantId,
      // The plaintext exists here and in the email, and nowhere else. It is
      // never returned to a caller and never logged — `ConsoleMailer` renders
      // the link locally and is not bound outside development.
      data: { linkPath: RESET_PASSWORD_LINK_PATH, token, displayName: user.name },
    });
  }

  /**
   * `POST /api/v1/auth/password-reset/confirm`. Redeems the link, sets the
   * password and signs the account out everywhere.
   *
   * No session is issued. The user logs in fresh with the new password, which is
   * both the simpler contract and the thing that proves to them the reset did
   * what they think it did.
   */
  async confirm(input: PasswordResetConfirmInput): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    const tokenHash = hashResetToken(input.token);

    // One indexed read before anything expensive happens. This route is
    // unauthenticated and there is no API-wide rate limiter yet (TAR-59), so
    // hashing first would let anybody spend a full argon2id pass — 19 MiB and a
    // libuv thread — per request, with a token they invented and no query ever
    // reaching the database to show where the load came from.
    //
    // Deliberately only the two verdicts a clock cannot change: no such token,
    // or one already spent. Expiry stays with the `UPDATE` below, because
    // judging it here would mean a node running fast could refuse a link
    // Postgres considers live. Reaching the hash therefore requires presenting
    // an unspent 256-bit token that was genuinely issued, which is not a load
    // an attacker can manufacture.
    //
    // The conditional `UPDATE` remains the authoritative single-use gate — this
    // read is only there to make the rubbish case cheap. Same ordering, for the
    // same reason, as `InviteService.accept`.
    const presented = await this.readToken(tokenHash);

    if (presented === null || presented.consumedAt !== null) {
      throw new ResetTokenInvalidError(presented === null ? 'unknown' : 'consumed');
    }

    // Hashed before the transaction opens. argon2id is deliberately expensive,
    // and holding a transaction — and the connection under it — open for the
    // duration would put that cost on the pool rather than on this request.
    const passwordHash = await this.passwords.hash(input.password);

    const redemption = await this.prisma.$tenantTransaction<Redemption>(async (tx) => {
      const redeemed = await tx.$queryRaw<{ userId: string }[]>`
        UPDATE password_reset_tokens
           SET consumed_at = now()
         WHERE token_hash = ${tokenHash}
           AND consumed_at IS NULL
           AND expires_at > now()
        RETURNING user_id AS "userId"
      `;

      const userId = redeemed[0]?.userId;

      if (userId === undefined) {
        return { outcome: 'not-redeemable' };
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { email: true, status: true },
      });

      if (user === null || user.status !== 'active') {
        // The token is spent either way — it was live, and it has now been
        // presented. Refusing without burning it would leave a working link
        // attached to an account somebody deliberately deactivated.
        return { outcome: 'owner-inactive' };
      }

      // Any other link mailed to this person is dead now, not merely superseded.
      await tx.passwordResetToken.updateMany({
        where: { tenantId, userId, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          // A completed reset clears the lockout. Otherwise the one path out of
          // "I forgot my password and then locked myself out" would still end at
          // a 429, which is the exact situation a reset is for.
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
        select: { id: true },
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.passwordResetCompleted,
        targetType: 'user',
        targetId: userId,
      });

      const sessionsRevoked = await this.sessions.revokeFor(tx, tenantId, userId, 'password_reset');

      return { outcome: 'reset', userId, email: user.email, sessionsRevoked };
    });

    if (redemption.outcome === 'not-redeemable') {
      throw new ResetTokenInvalidError(await this.classifyRejection(tokenHash));
    }

    if (redemption.outcome === 'owner-inactive') {
      throw new ResetTokenInvalidError('revoked');
    }

    // The after-commit half of the revocation, which `SessionRevocationService`
    // documents as mandatory rather than advisory. `revokeFor` purges the cache
    // *before* it writes `revoked_at`, so between those two moments an in-flight
    // request can miss, read the still-live row and write it back — and a
    // session this reset just killed would keep answering for up to
    // `sessionCacheTtlMs`. That window is the whole thing a reset exists to
    // close: the person resetting is often not the person holding the others.
    await this.sessions.purgeCacheFor(tenantId, redemption.userId);

    // The Redis half of the lockout clear above. Without it the reset leaves
    // the address refused for the rest of `loginLockoutMs`, which is the exact
    // "forgot my password and then locked myself out" dead end the columns are
    // cleared to avoid.
    await this.loginThrottle.clearEmailFailures(tenantId, redemption.email);

    this.logger.log(`Password reset completed; ${redemption.sessionsRevoked} session(s) revoked.`);

    await this.send({
      to: redemption.email,
      template: 'password_changed',
      tenantId,
      data: {},
    });
  }

  /**
   * Whether this account has already asked for more links than
   * `AUTH_POLICY.resetRequestsPerEmailPerHour` in the last hour.
   *
   * Counted over `password_reset_tokens` rather than in Redis, which makes it
   * durable, tenant-scoped by RLS for free, and served by the existing
   * `(tenant_id, user_id)` index. It counts rows issued, not requests made, so
   * it bounds exactly the thing it is there to bound: messages sent to a real
   * mailbox.
   *
   * The window is measured against this node's clock rather than the database's.
   * That is a deliberate difference from the expiry checks: a few seconds of
   * skew changes how many links an hour allows, and cannot revive a dead token.
   *
   * ⚠️ The per-IP half of TAR-53's policy (`resetRequestsPerIpPerHour`) is **not**
   * here. It needs the Redis sliding window TAR-59 builds for login failures —
   * the same `{tenantId}:{ip}` key shape — and a second, table-based
   * implementation of it would be a duplicate to unpick later. Recorded as a
   * follow-up on TAR-57 rather than left silently missing.
   */
  private async isThrottled(userId: string): Promise<boolean> {
    const issued = await this.prisma.passwordResetToken.count({
      where: { userId, createdAt: { gte: new Date(Date.now() - THROTTLE_WINDOW_MS) } },
    });

    return issued >= AUTH_POLICY.resetRequestsPerEmailPerHour;
  }

  /**
   * Why the conditional update matched nothing, for the message the reset screen
   * shows.
   *
   * Runs only on a path that has already decided to refuse, and reads two
   * timestamps — it grants nothing. Another tenant's token reads as `unknown`,
   * because RLS filters this query exactly as it filtered the update.
   *
   * The `expired` branch compares against this node's clock, unlike the decision
   * itself: at this point the database has already ruled, and this is choosing
   * wording.
   */
  private async classifyRejection(tokenHash: string): Promise<TokenRejectionReason> {
    const token = await this.readToken(tokenHash);

    if (token === null) {
      return 'unknown';
    }

    return token.consumedAt !== null ? 'consumed' : 'expired';
  }

  /**
   * The one read of a presented token, shared by `confirm`'s pre-flight refusal
   * and by the classification that words a refusal the database made.
   *
   * Re-read rather than passed along between the two: a concurrent redemption
   * can spend the token between them, and the later answer is the true one.
   */
  private readToken(
    tokenHash: string,
  ): Promise<{ consumedAt: Date | null; expiresAt: Date } | null> {
    return this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { consumedAt: true, expiresAt: true },
    });
  }

  /**
   * Delivery must never fail the flow it accompanies. The reset row is already
   * committed, and a 500 from a mail provider would tell an unauthenticated
   * caller that their address exists — the one thing the unconditional 204 is
   * there to hide.
   */
  private async send(message: Parameters<MailerPort['send']>[0]): Promise<void> {
    try {
      await this.mailer.send(message);
    } catch (error: unknown) {
      this.logger.error(
        `Could not send the ${message.template} email for tenant ${message.tenantId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
