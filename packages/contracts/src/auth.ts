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
 */

/** Fixed here so the API, the Next.js proxy and the tests cannot disagree. */
export const SESSION_COOKIE_NAME = 'wac_session';

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
 */
export const PasswordSchema = z.string().min(12).max(256);

export const PasswordResetConfirmInputSchema = z.object({
  token: z.string().min(1),
  password: PasswordSchema,
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
export type InviteCreateInput = z.infer<typeof InviteCreateInputSchema>;
export type InviteResponse = z.infer<typeof InviteResponseSchema>;
export type InviteAcceptInput = z.infer<typeof InviteAcceptInputSchema>;
export type RealtimeTicketResponse = z.infer<typeof RealtimeTicketResponseSchema>;
