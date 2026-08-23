import type { AgentCapacity, TeamResponse, UserResponse } from '@whatsappcrm/contracts';

/**
 * Row → response. Explicit field by field, never a spread.
 *
 * The mapping is the boundary that stops a column reaching the API by accident:
 * `users` carries `password_hash`, and a handler that returned the row it
 * selected would publish it the day somebody widens the `select`. Written out,
 * adding a column to a query cannot add a field to the response.
 */

/** Exactly the columns a `UserResponse` needs, and no others. */
export interface UserRow {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: UserResponse['role'];
  status: UserResponse['status'];
  availability: UserResponse['availability'];
  lastSeenAt: Date | null;
  createdAt: Date;
  teamMemberships: readonly { teamId: string }[];
}

/**
 * Brute-force state, which TAR-54 adds to `users` and TAR-59 populates. Separate
 * from `UserRow` because it is fetched and returned under a different condition
 * from the rest of the record.
 */
export interface UserSecurityRow {
  lockedUntil: Date | null;
  failedLoginAttempts: number;
}

/**
 * The per-agent cap column (TAR-384). Separate from `UserRow` for the same
 * reason as the security state: it is published under a different permission
 * from the rest of the record, and the number beside it — `activeTicketCount` —
 * is not on `users` at all.
 */
export interface UserCapacityRow {
  maxConcurrentTickets: number | null;
}

/**
 * `security` defaults to `null`, which is what a caller **without**
 * `user:update` must see (TAR-53). Making the argument explicit rather than
 * reading the principal in here keeps the mapper a pure row→response function
 * and puts the permission decision at the handler, where the principal already
 * is. Until TAR-54 lands the columns, every call site correctly passes nothing.
 *
 * `capacity` is gated the same way and for the same reason (TAR-384): `null` is
 * what a caller holding neither `assignment_rule:read` nor
 * `assignment_rule:write` must see, and defaulting to it means a new caller
 * leaks nothing by forgetting the argument.
 */
export function toUserResponse(
  row: UserRow,
  security: UserSecurityRow | null = null,
  capacity: AgentCapacity | null = null,
): UserResponse {
  return {
    id: row.id,
    email: row.email,
    displayName: row.name,
    avatarUrl: row.avatarUrl,
    role: row.role,
    status: row.status,
    availability: row.availability,
    teamIds: row.teamMemberships.map((membership) => membership.teamId),
    // An admin can queue up a team of ten without being billed for people who
    // have not arrived (TAR-39, users contract), and a removed account stops
    // costing a seat the moment it is removed. A *suspended* user still holds
    // theirs: the account exists and is one click from active, and freeing the
    // seat on suspension would let a tenant park staff to dodge the plan limit.
    occupiesSeat: row.status === 'active' || row.status === 'suspended',
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    security:
      security === null
        ? null
        : {
            lockedUntil: security.lockedUntil?.toISOString() ?? null,
            failedLoginAttempts: security.failedLoginAttempts,
          },
    assignmentCapacity: capacity,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface TeamRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  members: readonly { userId: string }[];
}

export function toTeamResponse(row: TeamRow): TeamResponse {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    memberUserIds: row.members.map((member) => member.userId),
    createdAt: row.createdAt.toISOString(),
  };
}
