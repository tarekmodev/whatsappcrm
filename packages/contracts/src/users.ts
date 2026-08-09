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

export const USER_STATUSES = ['invited', 'active', 'suspended'] as const;
export const UserStatusSchema = z.enum(USER_STATUSES);

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
  createdAt: TimestampSchema,
});

export const UserListQuerySchema = CursorPageQuerySchema.extend({
  role: TenantRoleSchema.optional(),
  status: UserStatusSchema.optional(),
  teamId: IdSchema.optional(),
  q: z.string().min(1).max(120).optional(),
});

export const UserUpdateInputSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  role: TenantRoleSchema.optional(),
  teamIds: z.array(IdSchema).optional(),
  status: UserStatusSchema.optional(),
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
export type AgentAvailability = z.infer<typeof AgentAvailabilitySchema>;
export type UserResponse = z.infer<typeof UserResponseSchema>;
export type UserListQuery = z.infer<typeof UserListQuerySchema>;
export type UserUpdateInput = z.infer<typeof UserUpdateInputSchema>;
export type TeamResponse = z.infer<typeof TeamResponseSchema>;
export type TeamCreateInput = z.infer<typeof TeamCreateInputSchema>;
export type TeamUpdateInput = z.infer<typeof TeamUpdateInputSchema>;
