import 'server-only';

import {
  ConversationAssignInputSchema,
  ConversationListQuerySchema,
  CursorPageQuerySchema,
  InternalNoteCreateInputSchema,
  InviteCreateInputSchema,
  MessageListQuerySchema,
  PasswordChangeInputSchema,
  PasswordResetConfirmInputSchema,
  PasswordResetRequestInputSchema,
  TeamCreateInputSchema,
  TeamUpdateInputSchema,
  UserListQuerySchema,
  UserUpdateInputSchema,
  WhatsAppEmbeddedSignupInputSchema,
  isRoleWithin,
  roleHasPermission,
  whatsAppSignupFailureDetails,
  type ApiError,
  type ConnectedWhatsAppBusinessAccountResponse,
  type ConversationResponse,
  type CursorPage,
  type InternalNoteResponse,
  type MessageResponse,
  type Permission,
  type SessionPrincipal,
  type SessionResponse,
  type TeamResponse,
  type UserResponse,
} from '@whatsappcrm/contracts';
import { ApiRequestError, type ApiRequest } from '@/lib/api/http';
import { mockState, nextMockId } from '@/lib/api/mock/store';
import type {
  MockConversation,
  MockInternalNote,
  MockMessage,
  MockTeam,
  MockUser,
  TenantScoped,
} from '@/lib/api/mock/fixtures';
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

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
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
  {
    method: 'GET',
    pattern: new RegExp(`^/v1/conversations/${UUID_SEGMENT}$`),
    permission: 'conversation:read',
    handle: getConversation,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/v1/conversations/${UUID_SEGMENT}/messages$`),
    permission: 'conversation:read',
    handle: listMessages,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/v1/conversations/${UUID_SEGMENT}/notes$`),
    permission: 'conversation:read',
    handle: listInternalNotes,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/conversations/${UUID_SEGMENT}/notes$`),
    permission: 'conversation:note',
    handle: createInternalNote,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/conversations/${UUID_SEGMENT}/assign$`),
    // Supervisor and above. An agent may read work nobody has claimed and may
    // not take it — ADR 0002 amendment 4, restated as a refusal here so the
    // console's permission gate is exercised against a real 403.
    permission: 'conversation:assign',
    handle: assignConversation,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/auth\/session$/,
    // Gated by no permission: this endpoint's answer *is* the caller's role, so a
    // permission check on it could only ever be circular.
    permission: null,
    handle: currentSession,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/logout$/,
    permission: null,
    handle: logout,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/password-reset$/,
    // Reachable with no session at all: the caller has lost their way in.
    permission: null,
    handle: requestPasswordReset,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/password-reset\/confirm$/,
    permission: null,
    handle: confirmPasswordReset,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/whatsapp\/business-accounts$/,
    permission: 'channel:manage',
    handle: connectWhatsAppBusinessAccount,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/password$/,
    // Signed in, but gated by no permission — the resource *is* the caller, and
    // no role should be unable to change its own password.
    permission: null,
    handle: changePassword,
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
    // A soft delete has to be absent from every screen, not merely marked, so
    // `removed` is excluded unless asked for by name. Filtering it in some queries
    // and not others is how a "deleted" account reappears in a picker.
    .filter((user) => status !== undefined || user.status !== 'removed')
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

  // Mirrors the API's `assertMayAssign`. `InviteCreateInputSchema.role` accepts any
  // role, so without this a supervisor holding `user:invite` could mint an admin.
  if (!roleHasPermission(principal.role, 'user:set_role')) {
    if (role !== 'agent') {
      throw refused('forbidden', 'You can only invite someone as an agent.');
    }
  } else if (!isRoleWithin(role, principal.role)) {
    throw refused('forbidden', 'You cannot grant a role above your own.');
  }

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
    // Lockout is not modelled in the mock transport — see `fixtures.ts`.
    security: null,
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

  // The three role-assignment invariants, mirroring the API's `assertMayChangeRole`.
  // `user:update` alone does not carry the right to assign a role.
  if (role !== undefined) {
    if (user.id === principal.userId) {
      throw refused('forbidden', 'You cannot change your own role.');
    }

    if (!roleHasPermission(principal.role, 'user:set_role')) {
      throw refused('forbidden', 'Assigning a role requires the user:set_role permission.');
    }

    if (!isRoleWithin(role, principal.role)) {
      throw refused('forbidden', 'You cannot grant a role above your own.');
    }
  }

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

/**
 * A **soft** delete, matching TAR-81: the row survives with `status: 'removed'`, so
 * the record of what that person did is not destroyed and no foreign key is left
 * dangling. `listUsers` excludes them, which is what makes the account absent from
 * every screen.
 */
function removeUser({ principal, params }: RouteContext): null {
  const user = findUserInTenant(principal, params[0]);
  const state = mockState();

  state.users.set(user.id, { ...user, status: 'removed', teamIds: [], occupiesSeat: false });

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

// --- Session (TAR-56) ------------------------------------------------------

/**
 * The session bootstrap the route guard calls on every render.
 *
 * In mock mode the principal comes from the stub cookie, so what this returns is
 * the stub role — which is the point: it keeps the guard on its real code path
 * (`getSession` → `GET /v1/auth/session` → a parsed principal) instead of having a
 * second, mock-only branch that could pass while the real one is broken.
 *
 * It cannot answer 401. The fixture layer has no session to expire, and faking one
 * would make every mock-mode render a redirect to sign-in.
 */
function currentSession({ principal }: RouteContext): SessionResponse {
  return { user: principal };
}

/** 204 and nothing else, exactly like the real endpoint. There is no session row to drop. */
function logout(): null {
  return null;
}

// --- Passwords (TAR-57) ----------------------------------------------------
//
// The happy paths are unconditional, because the real endpoints are: a reset
// request answers 204 whatever the address is. The two failure paths a person
// actually meets — a dead link, a mistyped current password — are reachable
// through the sentinels below, so QA can walk them without an API and without a
// stopwatch to wait an hour for a token to expire.

/**
 * A reset token whose link is dead. Visit `/reset-password#token=expired` in mock
 * mode to see the "request a new link" state.
 */
export const MOCK_EXPIRED_RESET_TOKEN = 'expired';

/** Any other value is accepted as the current password; this one never is. */
export const MOCK_WRONG_CURRENT_PASSWORD = 'wrong';

function requestPasswordReset({ body }: RouteContext): null {
  if (!PasswordResetRequestInputSchema.safeParse(body).success) {
    throw validationFailed();
  }

  // Deliberately no lookup. Whether that address has an account is exactly what
  // this endpoint must not reveal.
  return null;
}

function confirmPasswordReset({ body }: RouteContext): null {
  const parsed = PasswordResetConfirmInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  if (parsed.data.token === MOCK_EXPIRED_RESET_TOKEN) {
    throw tokenInvalid();
  }

  return null;
}

function changePassword({ body }: RouteContext): null {
  const parsed = PasswordChangeInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  if (parsed.data.currentPassword === MOCK_WRONG_CURRENT_PASSWORD) {
    throw refused('invalid_credentials', 'The current password is incorrect.', HTTP_UNAUTHORIZED);
  }

  return null;
}

// --- WhatsApp (TAR-169) ----------------------------------------------------

/**
 * A signup code that this transport always refuses, so the console's failure
 * branch can be walked without a Meta app. Use it by editing the `code` in the
 * request, or reach it from the UI by running the flow against a Meta app that
 * takes longer than 30 seconds — the sentinel is the version that does not need
 * one.
 */
export const MOCK_EXPIRED_SIGNUP_CODE = 'expired';

/**
 * `POST /v1/whatsapp/business-accounts` — the tenant-facing connection.
 *
 * Stateless, unlike the users and teams above: there is no WABA in the fixture
 * store to update, because there is no tenant-facing `GET` for a later render to
 * read one back from. It answers with a plausible connected account so the
 * console's success view can be seen, and refuses the sentinel code above so the
 * failure view can be too. Both are what the real endpoint returns in shape; the
 * exchange it stands in for cannot be faked, and is not what this is for.
 */
function connectWhatsAppBusinessAccount({
  body,
}: RouteContext): ConnectedWhatsAppBusinessAccountResponse {
  const parsed = WhatsAppEmbeddedSignupInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  if (parsed.data.code === MOCK_EXPIRED_SIGNUP_CODE) {
    throw signupFailed('code_expired');
  }

  const businessAccountId = nextMockId();

  return {
    id: businessAccountId,
    wabaId: parsed.data.wabaId,
    name: 'Northwind Traders',
    verificationStatus: 'verified',
    createdAt: MOCK_CREATED_AT,
    updatedAt: MOCK_CREATED_AT,
    accounts: [
      {
        id: nextMockId(),
        whatsappBusinessAccountId: businessAccountId,
        phoneNumberId: parsed.data.phoneNumberId ?? '106540352242922',
        displayPhoneNumber: '+966501234567',
        verifiedName: 'Northwind Support',
        // Meta has not rated a number nobody has messaged yet.
        qualityRating: null,
        status: 'connected',
        createdAt: MOCK_CREATED_AT,
        updatedAt: MOCK_CREATED_AT,
      },
    ],
  };
}

/**
 * The one refusal in this file that carries an envelope, because the console
 * reads `details.reason` off it — a `whatsapp_signup_failed` without one would
 * exercise the fallback branch rather than the taxonomy the flow is built on.
 */
function signupFailed(reason: 'code_expired'): ApiRequestError {
  const message = 'This WhatsApp authorization expired before it could be used.';
  const envelope: ApiError = {
    error: {
      code: 'whatsapp_signup_failed',
      message,
      details: whatsAppSignupFailureDetails(reason),
      requestId: MOCK_REQUEST_ID,
    },
  };

  return new ApiRequestError(
    HTTP_BAD_REQUEST,
    'whatsapp_signup_failed',
    message,
    MOCK_REQUEST_ID,
    envelope,
  );
}

// --- Conversations ---------------------------------------------------------

/**
 * Mirrors `inboxScopeFilter` on the API side.
 *
 * `all` is **narrowed** rather than rejected for a caller without
 * `conversation:read_all`, so a supervisor's shared URL still renders for an
 * agent — with less in it. `unassigned` is open to everybody, because ADR 0002
 * amendment 4 rules that a conversation nobody has claimed is visible to every
 * agent on the tenant: it was created by a customer writing in, so an unclaimed
 * one would otherwise be visible to nobody at all.
 */
function listConversations({ principal, query }: RouteContext): CursorPage<ConversationResponse> {
  const parsed = ConversationListQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const { status, limit, scope } = parsed.data;

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
  if (scope === 'unassigned') {
    return isUnclaimed(conversation);
  }

  // `assigned` means "mine or my teams'" for every role — a filter the caller
  // chose, not a permission decision.
  if (scope === 'assigned') {
    return isAssignedTo(conversation, principal);
  }

  return (
    roleHasPermission(principal.role, 'conversation:read_all') ||
    isAssignedTo(conversation, principal) ||
    isUnclaimed(conversation)
  );
}

function getConversation({ principal, params }: RouteContext): ConversationResponse {
  return toConversationResponse(findConversationInTenant(principal, params[0]));
}

/**
 * `GET /v1/conversations/{id}/messages` — newest first, exactly as the API
 * pages a thread. The first page of a long conversation is its *end*.
 */
function listMessages({ principal, params, query }: RouteContext): CursorPage<MessageResponse> {
  const conversation = findConversationInTenant(principal, params[0]);
  const parsed = MessageListQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const { limit, order } = parsed.data;
  const items = tenantMessages(principal)
    .filter((message) => message.conversationId === conversation.id)
    // `sentAt` — the provider's timestamp, never insert order.
    .sort((left, right) =>
      order === 'asc'
        ? left.sentAt.localeCompare(right.sentAt)
        : right.sentAt.localeCompare(left.sentAt),
    )
    .slice(0, limit)
    .map(toMessageResponse);

  return { items, nextCursor: null };
}

/** `GET /v1/conversations/{id}/notes` — newest first. */
function listInternalNotes({
  principal,
  params,
  query,
}: RouteContext): CursorPage<InternalNoteResponse> {
  const conversation = findConversationInTenant(principal, params[0]);
  const parsed = CursorPageQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const items = tenantNotes(principal)
    .filter((note) => note.conversationId === conversation.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, parsed.data.limit)
    .map(toInternalNoteResponse);

  return { items, nextCursor: null };
}

/**
 * `POST /v1/conversations/{id}/notes`.
 *
 * The author is the principal and is never read from the body — a note is a
 * statement about who said what. Mentions are checked against this tenant, for
 * the reason the API checks them: a mention that names nobody notifies nobody
 * while looking as though it did.
 */
function createInternalNote({ principal, params, body }: RouteContext): InternalNoteResponse {
  const conversation = findConversationInTenant(principal, params[0]);
  const parsed = InternalNoteCreateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const mentionedUserIds = [...new Set(parsed.data.mentionedUserIds)];

  assertUsersInTenant(principal, mentionedUserIds);

  const created: MockInternalNote = {
    tenantId: principal.tenantId,
    id: nextMockId(),
    conversationId: conversation.id,
    authorUserId: principal.userId,
    body: parsed.data.body,
    mentionedUserIds,
    createdAt: MOCK_CREATED_AT,
  };

  mockState().internalNotes.set(created.id, created);

  return toInternalNoteResponse(created);
}

/**
 * `POST /v1/conversations/{id}/assign` — the claim.
 *
 * Absent leaves a column alone, `null` clears it, an id sets it; the three cases
 * are what let one endpoint claim, route to a team and release. An assignee who
 * is not an active member of this tenant is refused with `validation_failed`
 * naming the field, exactly as the API does.
 */
function assignConversation({ principal, params, body }: RouteContext): ConversationResponse {
  const conversation = findConversationInTenant(principal, params[0]);
  const parsed = ConversationAssignInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { userId, teamId } = parsed.data;

  if (typeof userId === 'string') {
    const user = findUserInTenant(principal, userId);

    if (user.status !== 'active') {
      throw refused(
        'validation_failed',
        'That user cannot take conversations.',
        HTTP_UNPROCESSABLE,
      );
    }
  }

  if (typeof teamId === 'string') {
    findTeamInTenant(principal, teamId);
  }

  const updated: MockConversation = {
    ...conversation,
    ...(userId === undefined ? {} : { assignedUserId: userId }),
    ...(teamId === undefined ? {} : { assignedTeamId: teamId }),
  };

  mockState().conversations.set(updated.id, updated);

  return toConversationResponse(updated);
}

function isUnclaimed(conversation: MockConversation): boolean {
  return conversation.assignedUserId === null && conversation.assignedTeamId === null;
}

function isAssignedTo(conversation: MockConversation, principal: SessionPrincipal): boolean {
  return (
    conversation.assignedUserId === principal.userId ||
    (conversation.assignedTeamId !== null &&
      principal.teamIds.includes(conversation.assignedTeamId))
  );
}

/**
 * The API's `isVisibleOrUnclaimed`, mirrored: everything in the tenant for a
 * principal holding `conversation:read_all`, otherwise their own work, their
 * teams' work, and anything nobody has claimed (ADR 0002 amendment 4).
 *
 * A thread outside that set answers `not_found`, never `forbidden` — a 403 would
 * confirm the id names a real conversation somebody else is handling.
 */
function findConversationInTenant(
  principal: SessionPrincipal,
  id: string | undefined,
): MockConversation {
  const conversation = tenantConversations(principal).find((candidate) => candidate.id === id);

  if (conversation === undefined) {
    throw notFound();
  }

  const isVisible =
    roleHasPermission(principal.role, 'conversation:read_all') ||
    isAssignedTo(conversation, principal) ||
    isUnclaimed(conversation);

  if (!isVisible) {
    throw notFound();
  }

  return conversation;
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

function tenantMessages(principal: SessionPrincipal): MockMessage[] {
  return [...mockState().messages.values()].filter(
    (message) => message.tenantId === principal.tenantId,
  );
}

function tenantNotes(principal: SessionPrincipal): MockInternalNote[] {
  return [...mockState().internalNotes.values()].filter(
    (note) => note.tenantId === principal.tenantId,
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

function toMessageResponse(message: MockMessage): MessageResponse {
  return stripTenant(message);
}

function toInternalNoteResponse(note: MockInternalNote): InternalNoteResponse {
  return stripTenant(note);
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

/** A refusal from a rule the route's declared permission does not express. */
function refused(code: string, message: string, status: number = HTTP_FORBIDDEN): ApiRequestError {
  return new ApiRequestError(status, code, message, MOCK_REQUEST_ID);
}

/**
 * A reset link that is unknown, expired, already used, or whose owner can no
 * longer sign in. 410 rather than 404, per TAR-53: the reset screen has to be
 * able to tell "dead link, ask for another" apart from "no such page".
 */
function tokenInvalid(): ApiRequestError {
  return refused(
    'token_invalid',
    'This password reset link has expired. Request a new one.',
    HTTP_GONE,
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
