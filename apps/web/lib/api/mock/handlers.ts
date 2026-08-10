import 'server-only';

import {
  ConversationListQuerySchema,
  InviteCreateInputSchema,
  TeamCreateInputSchema,
  TeamUpdateInputSchema,
  UserListQuerySchema,
  UserUpdateInputSchema,
  roleHasPermission,
  type ConversationResponse,
  type CursorPage,
  type Permission,
  type SessionPrincipal,
  type TeamResponse,
  type UserResponse,
} from '@whatsappcrm/contracts';
import { ApiRequestError, type ApiRequest } from '@/lib/api/http';
import { mockState, nextMockId } from '@/lib/api/mock/store';
import type { MockConversation, MockTeam, MockUser, TenantScoped } from '@/lib/api/mock/fixtures';
import { resolveStubPrincipal } from '@/lib/session/stub-principal';

/**
 * The mock transport: a small router over TAR-39's endpoint surface, standing in
 * for TAR-81 until its endpoints land.
 *
 * It is deliberately not a permissive stub. It enforces the same two rules the
 * real API does, so the UI is exercised against realistic refusals rather than
 * against a fixture layer that says yes to everything:
 *
 *   1. **Tenant scoping.** Every read filters on `principal.tenantId`. The
 *      fixtures seed a second tenant precisely so this is testable.
 *   2. **Permissions.** Each route declares the permission TAR-39's endpoint
 *      table assigns it, checked through the contract's `roleHasPermission`.
 *
 * A refusal is thrown as an `ApiRequestError` carrying a real code from
 * `error-codes.ts`, so the UI's error path is the same in both modes.
 */

interface Route {
  readonly method: ApiRequest['method'];
  readonly pattern: RegExp;
  readonly permission: Permission | null;
  readonly handle: (context: RouteContext) => unknown;
}

interface RouteContext {
  readonly principal: SessionPrincipal;
  readonly params: readonly string[];
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export async function handleMockRequest(request: ApiRequest): Promise<unknown> {
  const principal = await resolveStubPrincipal();
  const [pathname = '', rawQuery = ''] = request.path.split('?');

  for (const route of ROUTES) {
    if (route.method !== request.method) {
      continue;
    }

    const match = route.pattern.exec(pathname);

    if (match === null) {
      continue;
    }

    if (route.permission !== null && !roleHasPermission(principal.role, route.permission)) {
      throw forbidden(route.permission);
    }

    return route.handle({
      principal,
      params: match.slice(1).map((value) => value ?? ''),
      query: new URLSearchParams(rawQuery),
      body: request.body,
    });
  }

  throw new ApiRequestError(
    HTTP_NOT_FOUND,
    'not_found',
    `No mock handler for ${request.method} ${pathname}`,
    MOCK_REQUEST_ID,
  );
}

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const MOCK_REQUEST_ID = 'mock-request';
const UUID_SEGMENT = '([0-9a-fA-F-]{36})';

const ROUTES: readonly Route[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/users$/,
    permission: 'user:read',
    handle: listUsers,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/users\/invites$/,
    permission: 'user:invite',
    handle: inviteUser,
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/v1/users/${UUID_SEGMENT}$`),
    permission: 'user:update',
    handle: updateUser,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/v1/users/${UUID_SEGMENT}$`),
    permission: 'user:remove',
    handle: removeUser,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/teams$/,
    permission: 'team:read',
    handle: listTeams,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/teams$/,
    permission: 'team:write',
    handle: createTeam,
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/v1/teams/${UUID_SEGMENT}$`),
    permission: 'team:write',
    handle: updateTeam,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/conversations$/,
    permission: 'conversation:read',
    handle: listConversations,
  },
];

// --- Users -----------------------------------------------------------------

function listUsers({ principal, query }: RouteContext): CursorPage<UserResponse> {
  const parsed = UserListQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const { role, status, teamId, q, limit } = parsed.data;
  const needle = q?.trim().toLowerCase();

  const items = tenantUsers(principal)
    .filter((user) => role === undefined || user.role === role)
    .filter((user) => status === undefined || user.status === status)
    .filter((user) => teamId === undefined || user.teamIds.includes(teamId))
    .filter(
      (user) =>
        needle === undefined ||
        user.displayName.toLowerCase().includes(needle) ||
        user.email.toLowerCase().includes(needle),
    )
    .sort(byDisplayName)
    .slice(0, limit)
    .map(toUserResponse);

  return { items, nextCursor: null };
}

function inviteUser({ principal, body }: RouteContext): UserResponse {
  const parsed = InviteCreateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { email, role, teamIds } = parsed.data;
  const normalisedEmail = email.trim().toLowerCase();

  if (tenantUsers(principal).some((user) => user.email.toLowerCase() === normalisedEmail)) {
    throw new ApiRequestError(
      HTTP_UNPROCESSABLE,
      'conflict',
      'A user with that email already exists in this workspace.',
      MOCK_REQUEST_ID,
    );
  }

  const teams = assertTeamsInTenant(principal, teamIds);
  const created: MockUser = {
    tenantId: principal.tenantId,
    id: nextMockId(),
    email: normalisedEmail,
    displayName: normalisedEmail,
    avatarUrl: null,
    role,
    status: 'invited',
    availability: 'offline',
    teamIds: [...teamIds],
    // An invited-but-unaccepted user does not count toward the plan's seats.
    occupiesSeat: false,
    lastSeenAt: null,
    createdAt: MOCK_CREATED_AT,
  };

  mockState().users.set(created.id, created);
  syncTeamMembership(created.id, teams);

  return toUserResponse(created);
}

function updateUser({ principal, params, body }: RouteContext): UserResponse {
  const user = findUserInTenant(principal, params[0]);
  const parsed = UserUpdateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { displayName, role, teamIds, status } = parsed.data;
  const teams = teamIds === undefined ? null : assertTeamsInTenant(principal, teamIds);

  const updated: MockUser = {
    ...user,
    displayName: displayName ?? user.displayName,
    role: role ?? user.role,
    status: status ?? user.status,
    teamIds: teamIds === undefined ? user.teamIds : [...teamIds],
  };

  mockState().users.set(updated.id, updated);

  if (teams !== null) {
    syncTeamMembership(updated.id, teams);
  }

  return toUserResponse(updated);
}

function removeUser({ principal, params }: RouteContext): null {
  const user = findUserInTenant(principal, params[0]);
  const state = mockState();

  state.users.delete(user.id);

  for (const team of state.teams.values()) {
    if (team.memberUserIds.includes(user.id)) {
      state.teams.set(team.id, {
        ...team,
        memberUserIds: team.memberUserIds.filter((id) => id !== user.id),
      });
    }
  }

  // Their conversations survive the removal; they simply lose their owner.
  for (const conversation of state.conversations.values()) {
    if (conversation.assignedUserId === user.id) {
      state.conversations.set(conversation.id, { ...conversation, assignedUserId: null });
    }
  }

  return null;
}

// --- Teams -----------------------------------------------------------------

function listTeams({ principal, query }: RouteContext): CursorPage<TeamResponse> {
  const limit = Number(query.get('limit') ?? DEFAULT_PAGE_SIZE);
  const items = tenantTeams(principal)
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, Number.isFinite(limit) ? limit : DEFAULT_PAGE_SIZE)
    .map(toTeamResponse);

  return { items, nextCursor: null };
}

function createTeam({ principal, body }: RouteContext): TeamResponse {
  const parsed = TeamCreateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { name, description, memberUserIds } = parsed.data;

  assertUsersInTenant(principal, memberUserIds);

  const created: MockTeam = {
    tenantId: principal.tenantId,
    id: nextMockId(),
    name: name.trim(),
    description: description ?? null,
    memberUserIds: [...memberUserIds],
    createdAt: MOCK_CREATED_AT,
  };

  mockState().teams.set(created.id, created);
  syncUserTeamIds(created);

  return toTeamResponse(created);
}

/**
 * `PATCH /v1/teams/{id}` is how an agent is added to a team after the team
 * exists. `TeamUpdateInputSchema` is in the merged contract but the endpoint is
 * missing from TAR-39's table — flagged to TAR-81 on the issue. Without it, a
 * supervisor holding `team:write` could create a team and then never change its
 * membership, since `PATCH /v1/users/{id}` needs admin-only `user:update`.
 */
function updateTeam({ principal, params, body }: RouteContext): TeamResponse {
  const team = findTeamInTenant(principal, params[0]);
  const parsed = TeamUpdateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { name, description, memberUserIds } = parsed.data;

  if (memberUserIds !== undefined) {
    assertUsersInTenant(principal, memberUserIds);
  }

  const updated: MockTeam = {
    ...team,
    name: name?.trim() ?? team.name,
    description: description === undefined ? team.description : description,
    memberUserIds: memberUserIds === undefined ? team.memberUserIds : [...memberUserIds],
  };

  mockState().teams.set(updated.id, updated);
  syncUserTeamIds(updated);

  return toTeamResponse(updated);
}

// --- Conversations ---------------------------------------------------------

/**
 * Mirrors the contract's stated behaviour: a caller without
 * `conversation:read_all` has `scope` **silently narrowed** rather than
 * rejected, so a supervisor's shared URL still renders for an agent — with less
 * in it. See `ConversationListQuerySchema`.
 */
function listConversations({ principal, query }: RouteContext): CursorPage<ConversationResponse> {
  const parsed = ConversationListQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const { status, limit } = parsed.data;
  const mayReadAll = roleHasPermission(principal.role, 'conversation:read_all');
  const scope = mayReadAll ? parsed.data.scope : 'assigned';

  const items = tenantConversations(principal)
    .filter((conversation) => status === undefined || conversation.status === status)
    .filter((conversation) => matchesScope(conversation, scope, principal))
    .sort(byLastActivityDescending)
    .slice(0, limit)
    .map(toConversationResponse);

  return { items, nextCursor: null };
}

function matchesScope(
  conversation: MockConversation,
  scope: 'assigned' | 'unassigned' | 'all',
  principal: SessionPrincipal,
): boolean {
  if (scope === 'all') {
    return true;
  }

  if (scope === 'unassigned') {
    return conversation.assignedUserId === null && conversation.assignedTeamId === null;
  }

  // `assigned` for an agent means "mine or my teams'", which is exactly TAR-22's
  // first acceptance criterion.
  return (
    conversation.assignedUserId === principal.userId ||
    (conversation.assignedTeamId !== null &&
      principal.teamIds.includes(conversation.assignedTeamId))
  );
}

// --- Tenant-scoped readers -------------------------------------------------
// Nothing above iterates the store directly; every read goes through one of
// these three, which is what makes cross-tenant leakage a single-point concern.

function tenantUsers(principal: SessionPrincipal): MockUser[] {
  return [...mockState().users.values()].filter((user) => user.tenantId === principal.tenantId);
}

function tenantTeams(principal: SessionPrincipal): MockTeam[] {
  return [...mockState().teams.values()].filter((team) => team.tenantId === principal.tenantId);
}

function tenantConversations(principal: SessionPrincipal): MockConversation[] {
  return [...mockState().conversations.values()].filter(
    (conversation) => conversation.tenantId === principal.tenantId,
  );
}

/**
 * A record in another tenant answers 404, never 403 — the two are
 * indistinguishable by design so nothing can be enumerated across tenants
 * (`error-codes.ts`, `not_found`).
 */
function findUserInTenant(principal: SessionPrincipal, id: string | undefined): MockUser {
  const user = tenantUsers(principal).find((candidate) => candidate.id === id);

  if (user === undefined) {
    throw notFound();
  }

  return user;
}

function findTeamInTenant(principal: SessionPrincipal, id: string | undefined): MockTeam {
  const team = tenantTeams(principal).find((candidate) => candidate.id === id);

  if (team === undefined) {
    throw notFound();
  }

  return team;
}

function assertTeamsInTenant(principal: SessionPrincipal, ids: readonly string[]): MockTeam[] {
  return ids.map((id) => findTeamInTenant(principal, id));
}

function assertUsersInTenant(principal: SessionPrincipal, ids: readonly string[]): MockUser[] {
  return ids.map((id) => findUserInTenant(principal, id));
}

// --- Membership is stored twice, so it is synchronised in one place ---------

/** Keeps `team.memberUserIds` consistent after a user's `teamIds` changed. */
function syncTeamMembership(userId: string, teams: readonly MockTeam[]): void {
  const state = mockState();
  const target = new Set(teams.map((team) => team.id));

  for (const team of state.teams.values()) {
    const shouldContain = target.has(team.id);
    const doesContain = team.memberUserIds.includes(userId);

    if (shouldContain === doesContain) {
      continue;
    }

    state.teams.set(team.id, {
      ...team,
      memberUserIds: shouldContain
        ? [...team.memberUserIds, userId]
        : team.memberUserIds.filter((id) => id !== userId),
    });
  }
}

/** Keeps every `user.teamIds` consistent after a team's membership changed. */
function syncUserTeamIds(team: MockTeam): void {
  const state = mockState();
  const members = new Set(team.memberUserIds);

  for (const user of state.users.values()) {
    if (user.tenantId !== team.tenantId) {
      continue;
    }

    const shouldContain = members.has(user.id);
    const doesContain = user.teamIds.includes(team.id);

    if (shouldContain === doesContain) {
      continue;
    }

    state.users.set(user.id, {
      ...user,
      teamIds: shouldContain
        ? [...user.teamIds, team.id]
        : user.teamIds.filter((id) => id !== team.id),
    });
  }
}

// --- Serialisation ---------------------------------------------------------

/**
 * `tenantId` is an internal column and is stripped before anything leaves the
 * transport, exactly as the API's response serialiser does — the guard against a
 * scoping column reaching a client because someone returned a stored record
 * directly.
 *
 * The emptiness check is not decoration: it means a fixture or a write path that
 * forgot its tenant scope fails loudly here instead of quietly serialising a
 * record no reader can be sure about.
 */
function stripTenant<T extends TenantScoped>(record: T): Omit<T, 'tenantId'> {
  const { tenantId, ...rest } = record;

  if (tenantId.length === 0) {
    throw new Error('Mock record is missing its tenant scope.');
  }

  return rest;
}

function toUserResponse(user: MockUser): UserResponse {
  return stripTenant(user);
}

function toTeamResponse(team: MockTeam): TeamResponse {
  return stripTenant(team);
}

function toConversationResponse(conversation: MockConversation): ConversationResponse {
  return stripTenant(conversation);
}

// --- Helpers ---------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 25;
const MOCK_CREATED_AT = '2026-08-10T12:00:00.000Z';

function byDisplayName(left: MockUser, right: MockUser): number {
  return left.displayName.localeCompare(right.displayName);
}

function byLastActivityDescending(left: MockConversation, right: MockConversation): number {
  return (right.lastMessageAt ?? right.createdAt).localeCompare(
    left.lastMessageAt ?? left.createdAt,
  );
}

function forbidden(permission: Permission): ApiRequestError {
  return new ApiRequestError(
    HTTP_FORBIDDEN,
    'forbidden',
    `Your role does not include ${permission}.`,
    MOCK_REQUEST_ID,
  );
}

function notFound(): ApiRequestError {
  return new ApiRequestError(HTTP_NOT_FOUND, 'not_found', 'Not found.', MOCK_REQUEST_ID);
}

function validationFailed(): ApiRequestError {
  return new ApiRequestError(
    HTTP_UNPROCESSABLE,
    'validation_failed',
    'The request body did not match the contract.',
    MOCK_REQUEST_ID,
  );
}
