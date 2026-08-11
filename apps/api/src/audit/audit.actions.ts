/**
 * What gets audited, as a closed vocabulary (TAR-79, "every one of these
 * mutations writes an `audit_logs` row").
 *
 * A constant rather than free strings at the call sites: `audit_logs.action` is
 * the column an auditor filters on, and `user.role_changed` in one service
 * beside `user.roleChanged` in another makes the trail unqueryable without
 * anybody noticing. `<entity>.<past-tense-verb>`, always.
 *
 * These are the security-relevant events for people and teams. Other stories add
 * their own here — login, impersonation, tenant provisioning, data export — so
 * the whole set stays readable in one place.
 */
export const AUDIT_ACTIONS = {
  /**
   * Superseded by `invite.created` (TAR-55), and kept because rows carrying it
   * already exist: an auditor filtering the history of an account that was
   * invited before that change still has to find them. Nothing writes it any
   * more except the demo seeder, which reproduces that history on purpose.
   */
  userInvited: 'user.invited',
  inviteCreated: 'invite.created',
  inviteResent: 'invite.resent',
  inviteRevoked: 'invite.revoked',
  inviteAccepted: 'invite.accepted',
  userRoleChanged: 'user.role_changed',
  userStatusChanged: 'user.status_changed',
  userProfileChanged: 'user.profile_changed',
  userTeamsChanged: 'user.teams_changed',
  userRemoved: 'user.removed',
  teamCreated: 'team.created',
  teamUpdated: 'team.updated',
  sessionRevoked: 'session.revoked',
  /**
   * An account crossing `AUTH_POLICY.loginFailureThreshold` (TAR-53,
   * decision 3). Written on the *transition* into lockout, never per failed
   * attempt: one row per lockout is the event an admin acts on, while a row per
   * attempt would let an unauthenticated caller drive unbounded writes into the
   * table an auditor reads.
   */
  authLockout: 'auth.lockout',
  /**
   * An admin clearing a lockout through `POST /users/{id}/unlock` (TAR-59).
   * Written only when something was actually cleared, so a retried unlock does
   * not leave a second row claiming an account was rescued twice.
   */
  authUnlock: 'auth.unlock',
  /** A forgotten password recovered through a reset link (TAR-57). */
  passwordResetCompleted: 'password.reset_completed',
  /** A signed-in user changing their own password (TAR-57). */
  passwordChanged: 'password.changed',
  /**
   * A WhatsApp Business Account attached to a tenant (TAR-166), by an operator
   * pasting a token or — from TAR-168 — by a tenant admin completing Meta's
   * Embedded Signup. Connecting one hands the platform a credential that can
   * message a business's customers in its name, which is why it is audited at
   * all.
   *
   * The string is **exactly** what `business-account-connection.service.ts`
   * declared locally before this constant existed. Rows carrying it are already
   * written, and an auditor filtering the history of a connection made last
   * month still has to find them — so this moves where the value is spelled, not
   * what it says.
   */
  whatsappBusinessAccountConnected: 'whatsapp.business_account.connected',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Why a user's sessions were killed. Recorded on the `session.revoked` audit
 * row and, from TAR-56, written to `sessions.revoked_reason` — so the trail can
 * say why every session for one person died at 14:03 rather than only that they
 * did.
 *
 * The first four are somebody else acting on the account; the rest are the
 * account holder acting on their own.
 */
export const SESSION_REVOCATION_REASONS = [
  'role_change',
  'status_change',
  'teams_change',
  'removed',
  'logout',
  'logout_all',
  'session_revoked',
  /** A reset link redeemed. Every session dies — the person resetting may not be
   *  the person holding the others, which is the case the reset exists for. */
  'password_reset',
  /** A signed-in change. Every session *except the caller's* dies. */
  'password_change',
] as const;

export type SessionRevocationReason = (typeof SESSION_REVOCATION_REASONS)[number];
