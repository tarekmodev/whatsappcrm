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
  userInvited: 'user.invited',
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
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Why a user's sessions were killed. Recorded on the `session.revoked` audit
 * row and, from TAR-56, written to `sessions.revoked_reason` — so the trail can
 * say why every session for one person died at 14:03 rather than only that they
 * did.
 *
 * The first four are somebody else acting on the account; the last three are
 * the account holder acting on their own.
 */
export const SESSION_REVOCATION_REASONS = [
  'role_change',
  'status_change',
  'teams_change',
  'removed',
  'logout',
  'logout_all',
  'session_revoked',
] as const;

export type SessionRevocationReason = (typeof SESSION_REVOCATION_REASONS)[number];
