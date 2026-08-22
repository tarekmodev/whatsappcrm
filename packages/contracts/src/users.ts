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
 * The account lifecycle, and the exact vocabulary of the `user_status` column.
 *
 * `removed` was in the schema and missing here — the same drift TAR-80 closed on
 * `user_role` by deleting `owner`, in the other direction. A row holding it
 * would fail `UserResponseSchema` and answer 500, so it is added rather than
 * dropped: unlike `owner`, this one has a job. `DELETE /users/{id}` sets it,
 * because a user cannot be hard-deleted without either destroying the record of
 * what they did or leaving a foreign key dangling — see the delete path in the
 * API for the whole argument.
 *
 * ```
 *   invited ──accept──▶ active ◀──restore──▶ suspended
 *      │                  │                     │
 *      └──────────────────┴──────remove─────────┴──▶ removed
 * ```
 */
export const USER_STATUSES = ['invited', 'active', 'suspended', 'removed'] as const;
export const UserStatusSchema = z.enum(USER_STATUSES);

/**
 * The statuses a `PATCH /users/{id}` may set, which is deliberately narrower.
 *
 * `invited` is written by the invite flow and unset by acceptance; `removed` is
 * written by `DELETE /users/{id}`, which is gated on admin-only `user:remove`.
 * Allowing either here would let a supervisor holding `user:update` remove an
 * account through the side door — the permission split of TAR-79's delta 2 is
 * only real if the field cannot express the operation it excludes.
 */
export const USER_WRITABLE_STATUSES = ['active', 'suspended'] as const;
export const UserWritableStatusSchema = z.enum(USER_WRITABLE_STATUSES);

/**
 * Availability drives auto-assignment (TAR-23): an `away` or `offline` agent is
 * skipped by round-robin. It is set explicitly by the agent, not inferred from
 * socket presence — a dropped WiFi connection must not silently stop routing
 * work to someone who is at their desk.
 */
export const AGENT_AVAILABILITY = ['available', 'away', 'offline'] as const;
export const AgentAvailabilitySchema = z.enum(AGENT_AVAILABILITY);

/**
 * Brute-force state for one account (TAR-53's lockout policy, TAR-59's
 * enforcement).
 *
 * Split into its own object rather than flattened onto `UserResponse` so the
 * whole thing can be gated with one nullable check. `GET /api/v1/users` is
 * `user:read`, which every agent holds — flat fields would give any agent a live
 * readout of how close a named colleague is to being locked out, and
 * confirmation when it lands. TAR-35 asks for a lockout observable to a tenant
 * *admin*, not to the tenant.
 */
export const UserSecurityStateSchema = z.object({
  /** Non-null while the account is locked. Cleared by `POST /api/v1/users/{id}/unlock`. */
  lockedUntil: TimestampSchema.nullable(),
  /** Consecutive failures since the last success or admin unlock. */
  failedLoginAttempts: z.int().min(0),
});

/**
 * Ceilings on the two membership arrays a request may carry.
 *
 * Neither is a limit a real tenant meets: 500 people in one team is already an
 * unusual shape, and somebody in 50 teams has stopped using teams as a
 * visibility boundary. They exist because the work a membership change does is
 * **per member** — every affected person's sessions are revoked and their
 * principal cache purged — so an unbounded array is an unbounded amount of work
 * one privileged caller can ask of a shared connection pool. The repo's own
 * "bounded payload sizes, never fetch an unbounded set" rule, applied to the one
 * entity here whose fan-out is not naturally small.
 */
export const TEAM_MEMBERSHIP_LIMITS = {
  /** Members one team may be given in a single `POST`/`PATCH /teams`. */
  membersPerTeam: 500,
  /** Teams one person may be placed in by a single `PATCH /users/{id}`. */
  teamsPerUser: 50,
} as const;

export const UserResponseSchema = z.object({
  id: IdSchema,
  email: z.email(),
  displayName: z.string().min(1).max(120),
  avatarUrl: z.url().nullable(),
  role: TenantRoleSchema,
  status: UserStatusSchema,
  availability: AgentAvailabilitySchema,
  teamIds: z.array(IdSchema).max(TEAM_MEMBERSHIP_LIMITS.teamsPerUser),
  /** Counts toward the plan's seat limit. Invited-but-unaccepted users do not. */
  occupiesSeat: z.boolean(),
  lastSeenAt: TimestampSchema.nullable(),
  /**
   * `null` for a caller without `user:update` — the serializer omits it rather
   * than the handler branching, so a new endpoint returning a `UserResponse`
   * cannot leak it by forgetting to. Never null for a caller who does hold the
   * permission: an admin reading `null` here could not tell "not locked" from
   * "not allowed to know".
   */
  security: UserSecurityStateSchema.nullable(),
  createdAt: TimestampSchema,
});

/**
 * `status` is a filter, not a default: the list excludes `removed` accounts
 * unless one is asked for by name, so a soft delete is actually absent from
 * every screen rather than merely marked. Filtering a soft delete in some
 * queries and not others is how a "deleted" record reappears in a picker.
 */
export const UserListQuerySchema = CursorPageQuerySchema.extend({
  role: TenantRoleSchema.optional(),
  status: UserStatusSchema.optional(),
  teamId: IdSchema.optional(),
  q: z.string().min(1).max(120).optional(),
});

/**
 * Identifies one person on `PATCH`/`DELETE /api/v1/users/{id}`. A schema rather
 * than a bare string so a malformed id is a `validation_failed` at the edge
 * instead of a database error two layers in.
 */
export const UserParamsSchema = z.object({
  id: IdSchema,
});

/**
 * `role` is separated from the rest at *enforcement* time, not here: a body
 * carrying it additionally requires `user:set_role` (TAR-79, delta 1), and a
 * caller without it is refused rather than having the field quietly dropped —
 * a privilege change that appears to succeed is worse than a refusal.
 */
export const UserUpdateInputSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  role: TenantRoleSchema.optional(),
  teamIds: z.array(IdSchema).max(TEAM_MEMBERSHIP_LIMITS.teamsPerUser).optional(),
  status: UserWritableStatusSchema.optional(),
});

/**
 * What `PATCH /users/{id}` answers: the user, plus the one side effect the
 * caller did not ask for.
 *
 * Suspending somebody disarms every workflow whose definition names them
 * (TAR-596) — an admin muting one agent can switch off the tenant's automation
 * without being told. TAR-605 asked whether that should instead write the
 * `workflow_broken` notifications the engine's own disarm path writes, and the
 * answer is no: `notifications.ticket_id` is `NOT NULL` and
 * `NotificationResponse` publishes `ticketId` and `ticketNumber` as required,
 * because every notification the table has ever held was raised *about a
 * ticket*. A suspension is raised about a person, so a row for it would need
 * that column relaxed, the two CHECKs rewritten and a published field made
 * nullable — a breaking contract change to deliver something the acting admin
 * is better told synchronously anyway. The audit trail already carries the
 * count; this puts it in front of the person who caused it.
 *
 * A separate schema rather than a field on `UserResponse`, so `GET /users` and
 * `GET /users/{id}` are not made to carry a number that means nothing there.
 *
 * `DELETE /users/{id}` answers 204 and has nowhere to put this. Its count stays
 * in the `user.removed` audit row, which is where a removal's other side
 * effects — assignments cleared, invites revoked — already are.
 */
export const UserUpdateResponseSchema = UserResponseSchema.extend({
  /**
   * How many workflows this request disarmed. `0` on every request that did not
   * suspend an active user, so a client may read it without branching on
   * `status`.
   */
  workflowsDisarmed: z.int().min(0),
});

export const AvailabilityUpdateInputSchema = z.object({
  availability: AgentAvailabilitySchema,
});

export const TeamResponseSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable(),
  /**
   * The whole membership, bounded by the ceiling the write paths enforce — so
   * the contract publishes a maximum response size rather than implying one.
   *
   * A team can still pass it one person at a time through `PATCH /users/{id}`,
   * which bounds `teamIds` rather than the far side of the relation. Making the
   * ceiling a database invariant needs a capacity check on every path that
   * writes `team_members`, including invite acceptance, and that is a separate
   * change with its own failure mode.
   */
  memberUserIds: z.array(IdSchema).max(TEAM_MEMBERSHIP_LIMITS.membersPerTeam),
  createdAt: TimestampSchema,
});

export const TeamCreateInputSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  memberUserIds: z.array(IdSchema).max(TEAM_MEMBERSHIP_LIMITS.membersPerTeam).default([]),
});

/**
 * `memberUserIds` is the whole membership, not a delta: sending it replaces the
 * team's members, and omitting it leaves them alone. A delta shape (`add`,
 * `remove`) reads better in isolation but loses to concurrent edits — two
 * supervisors each removing one person would each succeed against a membership
 * neither of them last saw.
 *
 * `.partial()` only makes the fields optional, so `memberUserIds` keeps the
 * `membersPerTeam` ceiling — a replace is the operation with the larger fan-out
 * of the two, not the smaller.
 */
export const TeamUpdateInputSchema = TeamCreateInputSchema.partial();

export const TeamParamsSchema = z.object({
  id: IdSchema,
});

/**
 * Teams are few per tenant — tens, not thousands — but the list still paginates,
 * because "few today" is not a property the API can promise a client.
 */
export const TeamListQuerySchema = CursorPageQuerySchema.extend({
  q: z.string().min(1).max(80).optional(),
});

export type UserStatus = z.infer<typeof UserStatusSchema>;
export type UserWritableStatus = z.infer<typeof UserWritableStatusSchema>;
export type AgentAvailability = z.infer<typeof AgentAvailabilitySchema>;
export type UserSecurityState = z.infer<typeof UserSecurityStateSchema>;
export type UserResponse = z.infer<typeof UserResponseSchema>;
export type UserUpdateResponse = z.infer<typeof UserUpdateResponseSchema>;
export type UserListQuery = z.infer<typeof UserListQuerySchema>;
export type UserParams = z.infer<typeof UserParamsSchema>;
export type UserUpdateInput = z.infer<typeof UserUpdateInputSchema>;
export type AvailabilityUpdateInput = z.infer<typeof AvailabilityUpdateInputSchema>;
export type TeamResponse = z.infer<typeof TeamResponseSchema>;
export type TeamCreateInput = z.infer<typeof TeamCreateInputSchema>;
export type TeamUpdateInput = z.infer<typeof TeamUpdateInputSchema>;
export type TeamParams = z.infer<typeof TeamParamsSchema>;
export type TeamListQuery = z.infer<typeof TeamListQuerySchema>;
