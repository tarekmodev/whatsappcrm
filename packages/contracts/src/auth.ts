import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { PermissionSchema, TenantRoleSchema } from './rbac';

/**
 * Session and authentication contract. TAR-35 implements it.
 *
 * Sessions are **opaque and server-side**, carried in an httpOnly cookie — not a
 * JWT. TAR-18 requires session revocation, and revoking a JWT means maintaining
 * a denylist, which is a session table wearing a disguise. The cookie holds a
 * random 256-bit id; every lookup is one indexed read (cached in Redis).
 *
 * TAR-39 fixed the mechanism and the endpoint list. TAR-53 fixes everything that
 * was left auth-specific — lifetimes, thresholds, token design, the cookie name
 * and the flows themselves — in
 * `docs/architecture/0005-auth-session-and-invite-contract.md`. Read that before
 * changing a number in this file: each one has a recorded reason.
 */

/**
 * The production cookie name, carrying the `__Host-` prefix.
 *
 * The prefix is a browser-enforced guarantee, not a naming convention: a browser
 * rejects a `__Host-` cookie that carries a `Domain` attribute, is missing
 * `Secure`, or has a `Path` other than `/`. Under white-label custom domains
 * that is exactly the property needed — it makes it impossible for a sibling
 * tenant subdomain to set, or shadow, the cookie another tenant's host sends.
 */
export const SESSION_COOKIE_NAME_SECURE = '__Host-wac_session';

/**
 * The development spelling, used only when `SESSION_COOKIE_SECURE=0`. Safari
 * does not treat plain-HTTP localhost as a secure context, so a `__Host-` cookie
 * cannot be set there at all and local development would be unable to log in.
 */
export const SESSION_COOKIE_NAME = 'wac_session';

/**
 * Fixed here so the API, the Next.js proxy and the tests cannot disagree on
 * which of the two names is in play.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_NAME_SECURE : SESSION_COOKIE_NAME;
}

/**
 * Every auth lifetime and threshold, in one frozen object.
 *
 * Exported from the contract rather than read from the API's config because
 * three consumers must agree on them: the API enforces them, the frontend renders
 * copy from them ("try again in 15 minutes"), and TAR-63's tests assert against
 * them. Three literals in three packages drift; one constant cannot.
 *
 * These are starting values chosen to be defensible, not measured ones — the
 * rationale for each is tabulated in the TAR-53 document. TAR-56 tunes the argon2
 * parameters against a real instance and TAR-59 may move the lockout numbers on
 * evidence; both are edits to this object alone.
 */
export const AUTH_POLICY = {
  /** Idle window. Extended on use, never past `sessionAbsoluteMs` from issue. */
  sessionIdleMs: 12 * 60 * 60 * 1000,
  /** Hard cap from issue. A stolen cookie cannot outlive it whatever the browser does. */
  sessionAbsoluteMs: 30 * 24 * 60 * 60 * 1000,
  /**
   * Minimum gap between two writes that slide `expires_at`. Without it, every
   * authenticated request in the product would `UPDATE` the sessions table.
   */
  sessionSlideThrottleMs: 5 * 60 * 1000,
  /** TAR-39's stated bound on how long a stale principal may outlive a role change. */
  sessionCacheTtlMs: 60 * 1000,

  /** Long enough to survive a holiday, short enough that a forwarded email goes stale. */
  inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** The user is at the keyboard now. Anything longer is a window, not a convenience. */
  passwordResetTtlMs: 60 * 60 * 1000,
  /** Fetched immediately before the socket connects, and single-use on top. */
  realtimeTicketTtlMs: 60 * 1000,

  /** Consecutive failures on one account before it locks. */
  loginFailureThreshold: 10,
  /** 10 guesses per 15 minutes is useless against a 12-character password. */
  loginLockoutMs: 15 * 60 * 1000,
  /**
   * Failures from one IP against one tenant per window. This is the layer that
   * catches spraying at addresses with no user row to count on.
   */
  ipFailureThreshold: 20,
  ipFailureWindowMs: 15 * 60 * 1000,

  /** Reset-request throttles. Neither is reported to the caller: the 204 is unconditional. */
  resetRequestsPerEmailPerHour: 5,
  resetRequestsPerIpPerHour: 20,

  /** Mirrors `PasswordSchema`, restated so one object governs every auth number. */
  passwordMinLength: 12,
  passwordMaxLength: 256,
} as const;

export type AuthPolicy = typeof AUTH_POLICY;

/**
 * Everything except `secure`, which follows the environment. Notably there is no
 * `domain`: a cookie scoped to the platform's parent domain would be sent to
 * every tenant subdomain underneath it.
 *
 * `SameSite=Lax` is also the CSRF defence — it keeps the cookie off cross-site
 * form POSTs — which is why no CSRF-token endpoint exists.
 *
 * `maxAge` is in **seconds**, per the `Set-Cookie` grammar, and is derived from
 * `sessionAbsoluteMs` rather than restated: the browser should drop a cookie the
 * server would reject anyway, and two independently-maintained numbers is how
 * that stops being true. Declared after `AUTH_POLICY` for that reason — a `const`
 * read before its initialiser is a module-load crash, not a type error.
 */
export const SESSION_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: AUTH_POLICY.sessionAbsoluteMs / 1000,
} as const;

/**
 * Everything a guard needs about the caller, resolved once per request and
 * published on `TenantContextService`. `permissions` is materialised from the
 * role at resolution time so no downstream code re-derives it.
 */
export const SessionPrincipalSchema = z.object({
  userId: IdSchema,
  tenantId: IdSchema,
  email: z.email(),
  displayName: z.string().min(1),
  role: TenantRoleSchema,
  permissions: z.array(PermissionSchema),
  /** Team memberships, used by assignment and to scope `_all`-less list queries. */
  teamIds: z.array(IdSchema),
  sessionId: IdSchema,
  expiresAt: TimestampSchema,
});

export type SessionPrincipal = z.infer<typeof SessionPrincipalSchema>;

/**
 * `GET /api/v1/auth/session` — the frontend's bootstrap call. Answers 401
 * `unauthenticated` rather than a null body when there is no session, so the
 * client has one branch instead of two.
 */
export const SessionResponseSchema = z.object({
  user: SessionPrincipalSchema,
});

/**
 * Login is tenant-resolved by request host, never by an email lookup across
 * tenants. The body therefore carries no tenant identifier, and no caller can
 * enumerate tenants by probing emails.
 */
export const LoginInputSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const LogoutInputSchema = z.object({
  /** Revokes every session for the user rather than just this one. */
  allSessions: z.boolean().default(false),
});

export const PasswordResetRequestInputSchema = z.object({
  email: z.email(),
});

/**
 * Password rules live in the contract so the frontend validates before a
 * round-trip and the API enforces the identical rule. A length floor with no
 * character-class theatre follows current NIST guidance.
 *
 * The upper bound is not cosmetic: argon2id has no bcrypt-style truncation, so
 * an unbounded password is an unbounded amount of memory-hard hashing an
 * unauthenticated caller can ask for.
 */
export const PasswordSchema = z
  .string()
  .min(AUTH_POLICY.passwordMinLength)
  .max(AUTH_POLICY.passwordMaxLength);

export const PasswordResetConfirmInputSchema = z.object({
  token: z.string().min(1),
  password: PasswordSchema,
});

/**
 * `POST /api/v1/auth/password` — changing your own password while signed in.
 *
 * `currentPassword` is required even though the caller already holds a valid
 * session. A session cookie proves the browser has a cookie; it does not prove
 * the person at the keyboard is the account holder, and without this an unlocked
 * laptop is a permanent account takeover.
 *
 * Succeeding revokes every *other* session for the user. The caller stays signed
 * in — which is what makes this the useful action after a suspected compromise.
 */
export const PasswordChangeInputSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: PasswordSchema,
});

/** Agent onboarding is invite-only at v1; TAR-36 adds tenant self-signup alongside it. */
export const InviteCreateInputSchema = z.object({
  email: z.email(),
  role: TenantRoleSchema,
  teamIds: z.array(IdSchema).default([]),
});

export const InviteResponseSchema = z.object({
  id: IdSchema,
  email: z.email(),
  role: TenantRoleSchema,
  invitedByUserId: IdSchema,
  expiresAt: TimestampSchema,
  acceptedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

export const InviteAcceptInputSchema = z.object({
  token: z.string().min(1),
  displayName: z.string().min(1).max(120),
  password: PasswordSchema,
});

/**
 * `POST /api/v1/invites/lookup` — what the invite-accept screen calls before it
 * renders, so the recipient sees who invited them and to what.
 *
 * The token travels in the **body of a POST**, not in the path of a `GET` as
 * TAR-39 first sketched it. A live credential in a URL is written into every
 * access log, proxy log and `Referer` header between the browser and the
 * handler; a body is not. The same reasoning moves invite acceptance to
 * `POST /api/v1/invites/accept` and keeps the emailed link's token in the URL
 * *fragment*, which browsers never transmit at all.
 */
export const InviteLookupInputSchema = z.object({
  token: z.string().min(1),
});

/**
 * Deliberately minimal. Enough for "Alice invited you to join Acme Support",
 * and nothing more — anyone holding a random string can call this, so it must
 * not become a tenant-enumeration oracle. An unknown, expired, revoked or
 * already-accepted token answers `token_invalid` (410) rather than describing
 * anything.
 */
export const InvitePreviewResponseSchema = z.object({
  email: z.email(),
  role: TenantRoleSchema,
  expiresAt: TimestampSchema,
  tenantName: z.string().min(1),
  invitedByName: z.string().min(1).nullable(),
});

/**
 * `GET /api/v1/auth/sessions` — the caller's own live sessions, so they can see
 * and drop a device they no longer recognise.
 *
 * Returned as a plain array rather than a `CursorPage`: the set is bounded by
 * how many devices one person signs in from, and paginating it would be
 * ceremony.
 */
export const SessionSummarySchema = z.object({
  id: IdSchema,
  createdAt: TimestampSchema,
  lastSeenAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** True for the session making this request, which the UI must not offer to revoke blindly. */
  current: z.boolean(),
});

export const SessionListResponseSchema = z.array(SessionSummarySchema);

/**
 * The transactional-email seam.
 *
 * Invites and password resets are undeliverable without one, and no provider has
 * been chosen for this platform yet (TAR-53, open question 2). Fixing the port
 * here lets TAR-55 and TAR-57 ship against a console adapter — the same shape
 * `FakeBillingProvider` gives TAR-37 — and leaves the vendor decision to TAR-41
 * without blocking anyone.
 */
export interface OutboundEmail {
  to: string;
  /**
   * Each member has exactly one producer, named in the TAR-53 document so none
   * of them is a template TAR-55 implements and nothing ever triggers:
   * `invite` from invite create and resend, `password_reset` from the reset
   * request, `password_changed` from reset-confirm and password-change, and
   * `account_locked` from the login failure that *crosses* the lockout
   * threshold — once per lockout, not once per failed attempt, which is what
   * bounds it as an unauthenticated caller's ability to send mail.
   */
  template: 'invite' | 'password_reset' | 'password_changed' | 'account_locked';
  tenantId: string;
  /**
   * Template variables. The rendered link is assembled by the adapter from the
   * tenant's **primary** hostname — never from the request `Host`, which an
   * attacker controls and could use to aim a genuine invite email at their own
   * server.
   */
  data: Record<string, string>;
}

export interface MailerPort {
  send(message: OutboundEmail): Promise<void>;
}

/**
 * Short-lived, single-use ticket for the WebSocket handshake.
 *
 * The socket cannot rely on the session cookie: under a white-label custom
 * domain the browser sits on the tenant's own host while the realtime server is
 * on the platform host, which makes that cookie third-party and therefore
 * blocked. The client fetches a ticket over the same-origin proxy and presents
 * it in the Socket.IO `auth` payload instead.
 */
export const RealtimeTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: TimestampSchema,
  /** Absolute origin of the realtime server, so the client never hardcodes it. */
  realtimeUrl: z.url(),
});

export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export type LoginInput = z.infer<typeof LoginInputSchema>;
export type LogoutInput = z.infer<typeof LogoutInputSchema>;
export type PasswordResetRequestInput = z.infer<typeof PasswordResetRequestInputSchema>;
export type PasswordResetConfirmInput = z.infer<typeof PasswordResetConfirmInputSchema>;
export type PasswordChangeInput = z.infer<typeof PasswordChangeInputSchema>;
export type InviteCreateInput = z.infer<typeof InviteCreateInputSchema>;
export type InviteResponse = z.infer<typeof InviteResponseSchema>;
export type InviteAcceptInput = z.infer<typeof InviteAcceptInputSchema>;
export type InviteLookupInput = z.infer<typeof InviteLookupInputSchema>;
export type InvitePreviewResponse = z.infer<typeof InvitePreviewResponseSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type RealtimeTicketResponse = z.infer<typeof RealtimeTicketResponseSchema>;
