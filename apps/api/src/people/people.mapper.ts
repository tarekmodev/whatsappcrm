import type { TeamResponse, UserResponse } from '@whatsappcrm/contracts';

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

export function toUserResponse(row: UserRow): UserResponse {
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
