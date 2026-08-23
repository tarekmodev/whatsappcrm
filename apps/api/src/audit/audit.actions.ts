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
  /**
   * Routing-rule writes (TAR-24). A rule is a standing instruction about where
   * customer conversations go, which is the same class of change as a team
   * membership edit — and 0004 audits those, so 0007 audits these.
   *
   * The metadata carries the rule's name and target, never its conditions: a
   * `contact_attribute` value is tenant data and can carry PII, and this table
   * is exported for compliance review rather than being a place to discover it.
   */
  assignmentRuleCreated: 'assignment_rule.created',
  assignmentRuleUpdated: 'assignment_rule.updated',
  assignmentRuleDeleted: 'assignment_rule.deleted',
  assignmentRuleReordered: 'assignment_rule.reordered',
  /**
   * Custom field definition writes (TAR-33, 0002 amendment 10). Tenant
   * configuration in the same class as a routing rule: a definition change
   * alters the shape of every contact record in the tenant, and a delete
   * destroys the values stored under that key across every contact — which is
   * the one action on this surface with no undo, so it has to leave a trail.
   *
   * Contact and tag *writes* are deliberately not audited. Editing a customer's
   * record is the product's ordinary work rather than a security event, and the
   * metadata would be the customer's own data — this table is exported for
   * compliance review and is not the place to discover PII, which is why the
   * routing-rule entries above carry a rule's name and never its conditions.
   */
  customFieldCreated: 'custom_field.created',
  customFieldUpdated: 'custom_field.updated',
  customFieldDeleted: 'custom_field.deleted',
  customFieldReordered: 'custom_field.reordered',
  /**
   * Canned-response writes (TAR-31, 0011). A canned response is standing text an
   * agent sends to a customer under the tenant's name, which is the same class
   * of change as a routing rule — and 0007 audits those.
   *
   * The metadata carries `shortcut` and `title`, never `body`: the body is
   * free-form copy that can carry customer-specific detail, and this table is
   * exported for compliance review rather than being a place to discover it.
   * Same reasoning as `assignment_rule.*` and its conditions.
   */
  cannedResponseCreated: 'canned_response.created',
  cannedResponseUpdated: 'canned_response.updated',
  cannedResponseDeleted: 'canned_response.deleted',
  /**
   * Workflow writes (TAR-27, 0009 security). A workflow is a standing
   * instruction that writes to tickets and messages supervisors without anybody
   * watching, which is the same class of change as a routing rule — and 0007
   * audits those.
   *
   * The metadata carries the workflow's name, its trigger type and its action
   * types, **never its conditions**: a condition can carry tenant data, and this
   * table is exported for compliance review rather than being a place to
   * discover it.
   */
  workflowCreated: 'workflow.created',
  workflowUpdated: 'workflow.updated',
  workflowDeleted: 'workflow.deleted',
  workflowReordered: 'workflow.reordered',
  /**
   * The **automatic** deactivation, written with a null actor: a reference the
   * definition names went missing, so the engine disarmed the workflow rather
   * than failing silently on every ticket (0009, decision 6). A supervisor
   * turning a workflow off by hand is a `workflow.updated`.
   */
  workflowDeactivated: 'workflow.deactivated',
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
  /**
   * A phone number registered for Cloud API sending, and the attempt that failed
   * (TAR-170). Registration sends a credential this platform generated to Meta
   * and is what makes a number able to message a business's customers, so both
   * outcomes are audited — the failure especially, because a number that
   * silently cannot send is the state that story exists to make visible.
   *
   * The metadata carries the phone number id, the WABA id, whether this was the
   * initial attempt or a retry, the published reason, and Meta's own numeric
   * code and `fbtrace_id` — the handle a support ticket with Meta is opened on.
   * **Never the PIN**, encrypted or not, and never Meta's free-text message,
   * which describes this app's grant and this app's configuration rather than
   * anything a tenant can act on.
   */
  whatsappPhoneNumberRegistered: 'whatsapp.phone_number.registered',
  whatsappPhoneNumberRegistrationFailed: 'whatsapp.phone_number.registration_failed',
  /**
   * The custom-domain lifecycle (TAR-29). Audited because a verified hostname
   * decides where invite and password-reset links are **mailed** —
   * `TenantLinkService.primaryHostname()` builds them from the primary domain —
   * so a claim, a proof and a removal are each a change to where live tokens go,
   * not a cosmetic setting.
   *
   * The metadata carries the hostname and the kind. It never carries the
   * verification token: that value is published in public DNS and is not a
   * credential, but this table is exported for compliance review and there is no
   * reason for a second copy of it to exist there.
   *
   * `activated` and `deactivated` are the platform operator attaching and
   * detaching the hostname at the edge, so their rows are the ones carrying an
   * `actor_label` rather than a user.
   */
  tenantDomainClaimed: 'tenant_domain.claimed',
  tenantDomainVerified: 'tenant_domain.verified',
  tenantDomainRemoved: 'tenant_domain.removed',
  tenantDomainActivated: 'tenant_domain.activated',
  tenantDomainDeactivated: 'tenant_domain.deactivated',
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
