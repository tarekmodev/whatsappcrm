import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { CursorPageQuerySchema } from './pagination';
import { TenantRoleSchema } from './rbac';

/**
 * Agents, supervisors, admins and teams. TAR-22 implements this.
 *
 * A user belongs to exactly one tenant — `UNIQUE (tenant_id, email)`, not a
 * global unique email. See the architecture doc for why, and for the migration
 * path if one person ever needs to work for two client organisations.
 */

/**
 * `removed` is here because removing a user is a **status change, not a row
 * delete** — a deleted user would take their audit trail, ticket history and
 * message authorship with them, and the schema's composite foreign keys cannot
 * express `SET NULL` on a partial key anyway. TAR-53 reconciles this set with
 * the `user_status` enum TAR-47 landed, which has had `removed` since day one.
 */
export const USER_STATUSES = ['invited', 'active', 'suspended', 'removed'] as const;
export const UserStatusSchema = z.enum(USER_STATUSES);

/**
 * What an admin may *set*. `invited` is missing on purpose: it is reachable only
 * by creating an invite, and letting a `PATCH` write it would produce a user who
 * can never sign in and has no live invite to accept.
 */
export const ASSIGNABLE_USER_STATUSES = ['active', 'suspended', 'removed'] as const;
export const AssignableUserStatusSchema = z.enum(ASSIGNABLE_USER_STATUSES);

/**
 * Availability drives auto-assignment (TAR-23): an `away` or `offline` agent is
 * skipped by round-robin. It is set explicitly by the agent, not inferred from
 * socket presence — a dropped WiFi connection must not silently stop routing
 * work to someone who is at their desk.
 */
export const AGENT_AVAILABILITY = ['available', 'away', 'offline'] as const;
export const AgentAvailabilitySchema = z.enum(AGENT_AVAILABILITY);

export const UserResponseSchema = z.object({
  id: IdSchema,
  email: z.email(),
  displayName: z.string().min(1).max(120),
  avatarUrl: z.url().nullable(),
  role: TenantRoleSchema,
  status: UserStatusSchema,
  availability: AgentAvailabilitySchema,
  teamIds: z.array(IdSchema),
  /** Counts toward the plan's seat limit. Invited-but-unaccepted users do not. */
  occupiesSeat: z.boolean(),
  lastSeenAt: TimestampSchema.nullable(),
  /**
   * Non-null while the account is locked out after repeated failed logins
   * (TAR-53's lockout policy, TAR-59's enforcement). Surfaced on the user list
   * because TAR-35 requires a lockout to be *observable to a tenant admin* — a
   * counter that lives only in Redis and never reaches an API response cannot
   * satisfy that. Cleared by `POST /api/v1/users/{id}/unlock`.
   */
  lockedUntil: TimestampSchema.nullable(),
  /** Consecutive failures since the last success or admin unlock. */
  failedLoginAttempts: z.int().min(0),
  createdAt: TimestampSchema,
});

export const UserListQuerySchema = CursorPageQuerySchema.extend({
  role: TenantRoleSchema.optional(),
  status: UserStatusSchema.optional(),
  teamId: IdSchema.optional(),
  q: z.string().min(1).max(120).optional(),
});

/**
 * Setting `status` to anything other than `active` is the **deactivation** path
 * of TAR-35: it revokes every session for that user in the same transaction, so
 * access ends immediately rather than at the next expiry. A change to `role` or
 * `status` that would leave the tenant with no active admin is rejected with
 * `conflict`.
 */
export const UserUpdateInputSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  role: TenantRoleSchema.optional(),
  teamIds: z.array(IdSchema).optional(),
  status: AssignableUserStatusSchema.optional(),
});

export const AvailabilityUpdateInputSchema = z.object({
  availability: AgentAvailabilitySchema,
});

export const TeamResponseSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable(),
  memberUserIds: z.array(IdSchema),
  createdAt: TimestampSchema,
});

export const TeamCreateInputSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  memberUserIds: z.array(IdSchema).default([]),
});

export const TeamUpdateInputSchema = TeamCreateInputSchema.partial();

export type UserStatus = z.infer<typeof UserStatusSchema>;
export type AssignableUserStatus = z.infer<typeof AssignableUserStatusSchema>;
export type AgentAvailability = z.infer<typeof AgentAvailabilitySchema>;
export type UserResponse = z.infer<typeof UserResponseSchema>;
export type UserListQuery = z.infer<typeof UserListQuerySchema>;
export type UserUpdateInput = z.infer<typeof UserUpdateInputSchema>;
export type TeamResponse = z.infer<typeof TeamResponseSchema>;
export type TeamCreateInput = z.infer<typeof TeamCreateInputSchema>;
export type TeamUpdateInput = z.infer<typeof TeamUpdateInputSchema>;
