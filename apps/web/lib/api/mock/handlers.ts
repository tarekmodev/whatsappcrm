import 'server-only';

import {
  AssignmentRuleCreateInputSchema,
  AssignmentRuleReorderInputSchema,
  AssignmentRuleUpdateInputSchema,
  ConversationAssignInputSchema,
  ConversationListQuerySchema,
  ConversationStatusUpdateInputSchema,
  CursorPageQuerySchema,
  IdSchema,
  InternalNoteCreateInputSchema,
  InviteCreateInputSchema,
  MessageListQuerySchema,
  MessageTemplateListQuerySchema,
  ROUTING_RULE_LIMITS,
  PasswordChangeInputSchema,
  PasswordResetConfirmInputSchema,
  PasswordResetRequestInputSchema,
  SendMessageInputSchema,
  SlaAlertListQuerySchema,
  TICKET_ACTIVE_STATUSES,
  TICKET_PRIORITIES,
  TICKET_STATUS_REQUIRES_CLOSE,
  TeamCreateInputSchema,
  TeamUpdateInputSchema,
  TicketAssignInputSchema,
  TicketListQuerySchema,
  TicketUpdateInputSchema,
  UserListQuerySchema,
  UserUpdateInputSchema,
  WhatsAppEmbeddedSignupInputSchema,
  canAgentTransition,
  isRoleWithin,
  isSlaBreached,
  renderTemplateBody,
  roleHasPermission,
  whatsAppSignupFailureDetails,
  type ApiError,
  type AssignmentRuleListResponse,
  type AssignmentRuleResponse,
  type ConnectedWhatsAppBusinessAccountResponse,
  type ConversationResponse,
  type CursorPage,
  type CustomFieldDefinition,
  type InternalNoteResponse,
  type MessageResponse,
  type MessageTemplateResponse,
  type Permission,
  type RoutingCondition,
  type RoutingTarget,
  type SendMessageInput,
  type SessionPrincipal,
  type SessionResponse,
  type SlaAlertResponse,
  type Tag,
  type TeamResponse,
  type TicketListQuery,
  type TicketResponse,
  type UserResponse,
} from '@whatsappcrm/contracts';
import { ApiRequestError, type ApiRequest } from '@/lib/api/http';
import { mockState, nextMockId } from '@/lib/api/mock/store';
import { MOCK_IDS } from '@/lib/api/mock/fixtures';
import type {
  MockAssignmentRule,
  MockConversation,
  MockCustomFieldDefinition,
  MockInternalNote,
  MockMessage,
  MockMessageTemplate,
  MockSlaAlert,
  MockTag,
  MockTeam,
  MockTicket,
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
  /**
   * As the caller set them, lower-cased keys. Only the send route reads one, and
   * it has to: `Idempotency-Key` is where the double-send guard lives, and a
   * transport that ignored it could not exercise the guard at all.
   */
  readonly headers: Readonly<Record<string, string>>;
}

export async function handleMockRequest(request: ApiRequest): Promise<unknown> {
  const principal = await resolveStubPrincipal();
  const [pathname = '', rawQuery = ''] = request.path.split('?');
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );

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
      headers,
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
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const MOCK_REQUEST_ID = 'mock-request';
const UUID_SEGMENT = '([0-9a-fA-F-]{36})';
/** Lower-cased: `handleMockRequest` normalises the request's header names. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

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
    pattern: /^\/v1\/assignment-rules$/,
    permission: 'assignment_rule:read',
    handle: listAssignmentRules,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/assignment-rules$/,
    permission: 'assignment_rule:write',
    handle: createAssignmentRule,
  },
  {
    // Before the `{id}` routes below only for readability — the patterns are
    // anchored, so `reorder` could never be read as a rule id anyway.
    method: 'POST',
    pattern: /^\/v1\/assignment-rules\/reorder$/,
    permission: 'assignment_rule:write',
    handle: reorderAssignmentRules,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/v1/assignment-rules/${UUID_SEGMENT}$`),
    permission: 'assignment_rule:read',
    handle: getAssignmentRule,
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/v1/assignment-rules/${UUID_SEGMENT}$`),
    permission: 'assignment_rule:write',
    handle: updateAssignmentRule,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/v1/assignment-rules/${UUID_SEGMENT}$`),
    permission: 'assignment_rule:write',
    handle: deleteAssignmentRule,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/tags$/,
    permission: 'contact:read',
    handle: listTags,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/custom-fields$/,
    permission: 'contact:read',
    handle: listCustomFieldDefinitions,
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
    pattern: new RegExp(`^/v1/conversations/${UUID_SEGMENT}/messages$`),
    permission: 'conversation:send',
    handle: sendMessage,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/message-templates$/,
    permission: 'conversation:send',
    handle: listMessageTemplates,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/conversations/${UUID_SEGMENT}/claim$`),
    // Every role. Taking work nobody holds is what a shared inbox is for
    // (TAR-186); what it can never do is take a thread off a colleague, which
    // the compare-and-set below enforces rather than the permission.
    permission: 'conversation:claim',
    handle: claimConversation,
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/v1/conversations/${UUID_SEGMENT}/status$`),
    // `conversation:read`, matching the API's own decorator: what gates a status
    // change is the hold, not the role, and the handler enforces that below.
    permission: 'conversation:read',
    handle: setConversationStatus,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/conversations/${UUID_SEGMENT}/assign$`),
    // Supervisor and above: releasing a thread, routing it to a team, and taking
    // one off the colleague working it. Restated as a refusal here so the
    // console's permission gate is exercised against a real 403.
    permission: 'conversation:assign',
    handle: assignConversation,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/tickets$/,
    permission: 'ticket:read',
    handle: listTickets,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/v1/tickets/${UUID_SEGMENT}$`),
    permission: 'ticket:read',
    handle: getTicket,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/sla-alerts$/,
    // `ticket:read`, not `sla:read`: every row names its recipient and the
    // handler narrows to the caller, so an agent may ask and gets nothing
    // (ADR 0006 — Security and Access).
    permission: 'ticket:read',
    handle: listSlaAlerts,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/sla-alerts/${UUID_SEGMENT}/acknowledge$`),
    permission: 'ticket:read',
    handle: acknowledgeSlaAlert,
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/v1/tickets/${UUID_SEGMENT}$`),
    // `ticket:update` at the guard; the terminal transitions additionally need
    // `ticket:close`, which is per-body and so is checked in the handler.
    permission: 'ticket:update',
    handle: updateTicket,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/tickets/${UUID_SEGMENT}/assign$`),
    permission: 'ticket:assign',
    handle: assignTicket,
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

// --- Assignment rules (TAR-24, contract 0007) ------------------------------

/**
 * The rule CRUD surface ADR 0007 publishes, standing in until TAR-288 ships it.
 *
 * It enforces the refusals the console has to render — duplicate name, the
 * per-tenant cap, enabling a rule with no target, a reorder that lost a race, and
 * a target or condition naming another tenant's record — because a fixture layer
 * that said yes to all of those would let every one of them through review.
 */

function listAssignmentRules({ principal }: RouteContext): AssignmentRuleListResponse {
  return assignmentRuleList(principal);
}

/**
 * `ORDER BY position ASC, id ASC` — 0007's decision 2. `position` defaults to 0
 * and carries no unique constraint, so without the id tie-break two rules created
 * without an explicit position would evaluate in whatever order the map yielded.
 * Ids are UUIDv7, so `id ASC` is creation order: oldest first, which is the answer
 * a supervisor would guess.
 */
function assignmentRuleList(principal: SessionPrincipal): AssignmentRuleListResponse {
  return { items: orderedTenantRules(principal).map(toAssignmentRuleResponse), nextCursor: null };
}

function getAssignmentRule({ principal, params }: RouteContext): AssignmentRuleResponse {
  return toAssignmentRuleResponse(findRuleInTenant(principal, params[0]));
}

function createAssignmentRule({ principal, body }: RouteContext): AssignmentRuleResponse {
  const parsed = AssignmentRuleCreateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { name, conditions, target, position, isActive } = parsed.data;
  const existing = orderedTenantRules(principal);

  if (existing.length >= ROUTING_RULE_LIMITS.rulesPerTenant) {
    // `conflict`, not `plan_limit_exceeded`: the cap is a property of the engine,
    // not of the tenant's plan, and money cannot fix it.
    throw ruleLimitReached();
  }

  assertRuleNameFree(existing, name, null);
  assertTargetInTenant(principal, target);
  assertConditionsResolvable(principal, conditions);

  const created: MockAssignmentRule = {
    tenantId: principal.tenantId,
    id: nextMockId(),
    name: name.trim(),
    // Omitted appends last, which is what the console always sends.
    position: position ?? nextRulePosition(existing),
    isActive,
    conditions: [...conditions],
    target,
    createdAt: MOCK_CREATED_AT,
    updatedAt: MOCK_CREATED_AT,
  };

  mockState().assignmentRules.set(created.id, created);

  return toAssignmentRuleResponse(created);
}

function updateAssignmentRule({ principal, params, body }: RouteContext): AssignmentRuleResponse {
  const rule = findRuleInTenant(principal, params[0]);
  const parsed = AssignmentRuleUpdateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { name, conditions, target, position, isActive } = parsed.data;

  if (name !== undefined) {
    assertRuleNameFree(orderedTenantRules(principal), name, rule.id);
  }

  if (target !== undefined) {
    assertTargetInTenant(principal, target);
  }

  if (conditions !== undefined) {
    assertConditionsResolvable(principal, conditions);
  }

  const nextTarget = target ?? rule.target;

  // 0007's conditional CHECK, completed by the API: the database permits a
  // target-less orphan so user removal can leave one behind, and this is what
  // stops it being re-enabled. The supervisor is told what is missing rather than
  // shown a constraint violation.
  if (isActive === true && nextTarget === null) {
    throw refused(
      'validation_failed',
      'Give this rule a target before enabling it.',
      HTTP_UNPROCESSABLE,
    );
  }

  const updated: MockAssignmentRule = {
    ...rule,
    name: name?.trim() ?? rule.name,
    conditions: conditions === undefined ? rule.conditions : [...conditions],
    target: nextTarget,
    position: position ?? rule.position,
    isActive: isActive ?? rule.isActive,
    updatedAt: MOCK_UPDATED_AT,
  };

  mockState().assignmentRules.set(updated.id, updated);

  // A `position` in a PATCH moves one rule past its neighbours. Renumbering the
  // whole set by the resulting sort is observably the same as 0007's shift, and
  // keeps `position` dense so the next move is not a no-op against a tie.
  if (position !== undefined) {
    renumberTenantRules(principal);
  }

  return toAssignmentRuleResponse(findRuleInTenant(principal, updated.id));
}

/**
 * Takes the tenant's **complete** rule set in evaluation order and rewrites
 * `position` to the array index.
 *
 * A submitted set that is not exactly the current one means another supervisor
 * created or deleted a rule since this client loaded the page, so it answers
 * `conflict` rather than performing a partial reorder — the optimistic
 * concurrency 0007 gets for free from the whole-set payload.
 */
function reorderAssignmentRules({ principal, body }: RouteContext): AssignmentRuleListResponse {
  const parsed = AssignmentRuleReorderInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { ruleIds } = parsed.data;
  const submitted = new Set(ruleIds);

  if (submitted.size !== ruleIds.length) {
    throw refused('validation_failed', 'A rule was listed twice.', HTTP_UNPROCESSABLE);
  }

  const current = orderedTenantRules(principal);

  if (current.length !== ruleIds.length || !current.every((rule) => submitted.has(rule.id))) {
    throw refused(
      'conflict',
      'The rule list changed while you were reordering it. Reload and try again.',
      HTTP_CONFLICT,
    );
  }

  const state = mockState();

  ruleIds.forEach((id, index) => {
    const rule = findRuleInTenant(principal, id);

    state.assignmentRules.set(id, { ...rule, position: index, updatedAt: MOCK_UPDATED_AT });
  });

  return assignmentRuleList(principal);
}

/** 204 either way: deleting an already-deleted rule is not an error. */
function deleteAssignmentRule({ principal, params }: RouteContext): null {
  const id = params[0];
  const rule = orderedTenantRules(principal).find((candidate) => candidate.id === id);

  if (rule !== undefined) {
    mockState().assignmentRules.delete(rule.id);
  }

  return null;
}

// --- Contact vocabulary (TAR-33's resources, read-only here) ---------------

function listTags({ principal }: RouteContext): CursorPage<Tag> {
  const items = tenantTags(principal)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(toTagResponse);

  return { items, nextCursor: null };
}

function listCustomFieldDefinitions({
  principal,
}: RouteContext): CursorPage<CustomFieldDefinition> {
  const items = tenantCustomFieldDefinitions(principal)
    .sort((left, right) => left.label.localeCompare(right.label))
    .map(toCustomFieldDefinitionResponse);

  return { items, nextCursor: null };
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

  const { status, limit, scope, q } = parsed.data;

  const items = tenantConversations(principal)
    .filter((conversation) => status === undefined || conversation.status === status)
    .filter((conversation) => matchesScope(conversation, scope, principal))
    .filter((conversation) => matchesSearch(conversation, q))
    .sort(byLastActivityDescending)
    .slice(0, limit)
    .map(toConversationResponse);

  return { items, nextCursor: null };
}

/**
 * The `?q=` the top bar's search sends. Name, phone and the last message, which
 * is what somebody typing into an inbox search is looking for; case-insensitive,
 * because a phone number is the only field here where case cannot vary.
 */
function matchesSearch(conversation: MockConversation, q: string | undefined): boolean {
  if (q === undefined) {
    return true;
  }

  const needle = q.trim().toLowerCase();
  const haystack = [
    conversation.contact.displayName,
    conversation.contact.phone,
    conversation.lastMessagePreview,
  ];

  return haystack.some((value) => value?.toLowerCase().includes(needle) === true);
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

  assertHeld(conversation);

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
 * `POST /v1/conversations/{id}/claim` — taking a thread nobody is on (TAR-186).
 *
 * The compare-and-set is mirrored rather than simplified: a thread somebody else
 * holds answers `conflict`, and the holder re-claiming gets their own thread
 * back. Those are the two branches the console has to render, so a mock that
 * always succeeded would leave both untested.
 */
function claimConversation({ principal, params }: RouteContext): ConversationResponse {
  const conversation = findConversationInTenant(principal, params[0]);

  if (conversation.assignedUserId === principal.userId) {
    return toConversationResponse(conversation);
  }

  if (conversation.assignedUserId !== null) {
    throw refused('conflict', 'Somebody else claimed this conversation first.', HTTP_CONFLICT);
  }

  // The team is left alone: a thread routed to Billing and picked up by one of
  // its members is still Billing's.
  const claimed: MockConversation = { ...conversation, assignedUserId: principal.userId };

  mockState().conversations.set(claimed.id, claimed);

  return toConversationResponse(claimed);
}

/**
 * `PATCH /v1/conversations/{id}/status`.
 *
 * Refused on a thread nobody holds, the same way a send and a note are
 * (TAR-186): closing a conversation is answering for it, and a shared pool where
 * anybody can close anybody's arriving work is not a shared pool.
 */
function setConversationStatus({ principal, params, body }: RouteContext): ConversationResponse {
  const conversation = findConversationInTenant(principal, params[0]);
  const parsed = ConversationStatusUpdateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  if (isUnclaimed(conversation)) {
    throw refused('conflict', 'Claim this conversation before changing its status.', HTTP_CONFLICT);
  }

  const updated: MockConversation = { ...conversation, status: parsed.data.status };

  mockState().conversations.set(updated.id, updated);

  return toConversationResponse(updated);
}

/**
 * `POST /v1/conversations/{id}/assign` — routing, hand-over and release.
 *
 * Absent leaves a column alone, `null` clears it, an id sets it; the three cases
 * are what let one endpoint route to a team, hand over and release. An assignee
 * who is not an active member of this tenant is refused with `validation_failed`
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

// --- Tickets (TAR-25, ADR 0006), and the flagged queue (TAR-23, ADR 0008) --

/**
 * `GET /v1/tickets` — the queue.
 *
 * Three rules mirrored rather than simplified, because each one is something the
 * console claims to be true:
 *
 *   1. **No `status` means the active queue** (`open` and `pending`). That
 *      default is what makes "resolving a ticket moves it out of the queue" true
 *      with no client change, so a mock that returned everything would leave the
 *      whole acceptance criterion untested.
 *   2. **One order: `priority DESC, createdAt DESC, id DESC`.** There is no sort
 *      parameter. Urgent-first depends on the *declaration order* of
 *      `TICKET_PRIORITIES`, which is load-bearing and invisible — `orderIndex`
 *      below is where that dependency is written down.
 *   3. **`unassigned` needs `ticket:read_all`.** Unlike an unclaimed
 *      conversation, an unassigned ticket is triaged work rather than a shared
 *      pool, so a caller without the permission is narrowed to their own rather
 *      than refused.
 *   4. **`breachedOnly` narrows to a breached timer** (TAR-26), *after* scope
 *      and status — so a supervisor's "everything overdue" link is still their
 *      tenant's, and still the active queue unless they asked otherwise.
 *   5. **`routingState` / `deferredReason` are the supervisor's flagged queue**
 *      (TAR-23). ADR 0008's landing view is this list with
 *      `?routingState=deferred`, not a resource of its own, and both are plain
 *      equality filters here because they are equalities in the database too —
 *      `tickets_routing_deferred_idx` exists so that finding stuck tickets is a
 *      predicate rather than a subquery over the event log.
 *   6. **A request pinned to the deferred set pages oldest-stuck first**, not in
 *      rule 2's order (ADR 0008 decision 3, amendment 3; TAR-365). The one place
 *      the list has two orders, and mirrored rather than simplified for the same
 *      reason as the rest: a mock that sorted the flagged queue by priority would
 *      teach mock mode an ordering the product does not have, and the console's
 *      "showing the N longest-waiting" line would be a claim only fixtures hold
 *      up.
 */
function listTickets({ principal, query }: RouteContext): CursorPage<TicketResponse> {
  const parsed = TicketListQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const {
    status,
    priority,
    scope,
    assignedUserId,
    assignedTeamId,
    breachedOnly,
    routingState,
    deferredReason,
    limit,
  } = parsed.data;

  const matched = tenantTickets(principal)
    .filter((item) =>
      status === undefined ? TICKET_ACTIVE_STATUSES.includes(item.status) : item.status === status,
    )
    .filter((item) => priority === undefined || item.priority === priority)
    // `breachedOnly` is an `EXISTS` against `sla_timers` on the API. Here it is
    // `isSlaBreached`, the same predicate the queue's overdue badge reads through
    // `ticketRowTone`, so a filter that disagreed with the badge beside it would
    // fail a test rather than ship.
    .filter((item) => !breachedOnly || isSlaBreached(item.sla))
    .filter((item) => assignedUserId === undefined || item.assignedUserId === assignedUserId)
    .filter((item) => assignedTeamId === undefined || item.assignedTeamId === assignedTeamId)
    .filter((item) => routingState === undefined || item.routing.state === routingState)
    .filter(
      (item) => deferredReason === undefined || item.routing.deferredReason === deferredReason,
    )
    .filter((item) => matchesTicketScope(item, scope, principal))
    // The flagged queue is the list's one second order, and which one applies
    // follows from the set that was asked for rather than from a `sort`
    // parameter. `deferredReason` pins the deferred set on its own: the API's
    // `tickets_routing_deferred_consistent` makes a non-null reason equivalent to
    // `routing_state = 'deferred'`, so the two entry conditions cannot describe
    // different sets.
    .sort(
      routingState === 'deferred' || deferredReason !== undefined ? byFlaggedOrder : byQueueOrder,
    );

  // A real cursor, not `null`: the supervisor's queue has to be able to tell
  // "that is all of them" from "that is the first page", and a transport that
  // always said the former would let the console report a filtered set as empty
  // when the query never looked past the page. Opaque to the client, so the last
  // id serves — nothing here pages on it yet.
  const items = matched.slice(0, limit);
  const nextCursor = matched.length > limit ? (items[items.length - 1]?.id ?? null) : null;

  return { items: items.map(toTicketResponse), nextCursor };
}

function getTicket({ principal, params }: RouteContext): TicketResponse {
  return toTicketResponse(findTicketInTenant(principal, params[0]));
}

/**
 * `PATCH /v1/tickets/{id}` — one transaction over status, priority and subject.
 *
 * The four answers the console is built around, all reachable here:
 *
 *   * a move the transition table refuses — `conflict`, naming the current
 *     status, exactly as the service does when its compare-and-set matches
 *     nothing;
 *   * a terminal transition without `ticket:close` — `forbidden`;
 *   * an empty body — `validation_failed`, from the schema's own `.refine`;
 *   * **setting the value it already has — 200 and no timestamp touched.** That
 *     is the no-op of ADR 0006 §2, not a conflict: a double-clicked button and a
 *     retry after a dropped response both arrive that way.
 */
function updateTicket({ principal, params, body }: RouteContext): TicketResponse {
  const current = findTicketInTenant(principal, params[0]);
  const parsed = TicketUpdateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { status, priority, subject } = parsed.data;

  if (status !== undefined && status !== current.status) {
    if (!canAgentTransition(current.status, status)) {
      throw refused(
        'conflict',
        `This ticket is ${current.status} and cannot be moved to ${status}.`,
        HTTP_CONFLICT,
      );
    }

    if (
      TICKET_STATUS_REQUIRES_CLOSE[status] &&
      !roleHasPermission(principal.role, 'ticket:close')
    ) {
      throw refused('forbidden', 'Your role does not include ticket:close.');
    }
  }

  const hasChange =
    (status !== undefined && status !== current.status) ||
    (priority !== undefined && priority !== current.priority) ||
    (subject !== undefined && subject !== current.subject);

  if (!hasChange) {
    return toTicketResponse(current);
  }

  const now = new Date().toISOString();
  const isEntering = (target: MockTicket['status']) =>
    status === target && current.status !== target;

  const updated: MockTicket = {
    ...current,
    status: status ?? current.status,
    priority: priority ?? current.priority,
    subject: subject ?? current.subject,
    // Written on the transition *into* the state, never derived from it and
    // never cleared. `open`/`pending` → `closed` leaves `resolvedAt` null
    // deliberately: that is the honest signal for "closed unworked".
    resolvedAt: isEntering('resolved') ? now : current.resolvedAt,
    closedAt: isEntering('closed') ? now : current.closedAt,
    updatedAt: now,
  };

  mockState().tickets.set(updated.id, updated);
  syncConversationTicketLink(updated);

  return toTicketResponse(updated);
}

/**
 * `POST /v1/tickets/{id}/assign` — the manual placement TAR-274 offers.
 *
 * Two writes, not one, and the second is the point: naming an assignee also moves
 * `routing.state` to `manual` and clears the deferred columns, which is what stops
 * a later routing pass overruling the supervisor. Modelled here rather than
 * assumed, because the row vanishing from the flagged queue afterwards is exactly
 * the behaviour that view is claiming.
 */
function assignTicket({ principal, params, body }: RouteContext): TicketResponse {
  const ticket = findTicketInTenant(principal, params[0]);
  const parsed = TicketAssignInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { userId, teamId } = parsed.data;

  if (typeof userId === 'string') {
    const user = findUserInTenant(principal, userId);

    if (user.status !== 'active') {
      throw refused('validation_failed', 'That user cannot take tickets.', HTTP_UNPROCESSABLE);
    }
  }

  if (typeof teamId === 'string') {
    findTeamInTenant(principal, teamId);
  }

  const assigned: MockTicket = {
    ...ticket,
    ...(userId === undefined ? {} : { assignedUserId: userId }),
    ...(teamId === undefined ? {} : { assignedTeamId: teamId }),
    routing: { state: 'manual', deferredReason: null, deferredSince: null },
  };

  mockState().tickets.set(assigned.id, assigned);

  return toTicketResponse(assigned);
}

/**
 * Keeps `conversation.ticketId` — the contact's *active* ticket — in step with a
 * status change.
 *
 * Modelled rather than left alone because it is what the inbox context panel
 * renders: resolving a ticket has to empty that section as well as remove the row
 * from the queue, and a fixture layer that kept the link would let a stale panel
 * ship looking fine.
 */
function syncConversationTicketLink(ticket: MockTicket): void {
  if (ticket.conversationId === null) {
    return;
  }

  const state = mockState();
  const conversation = state.conversations.get(ticket.conversationId);

  if (conversation === undefined) {
    return;
  }

  const isActive = TICKET_ACTIVE_STATUSES.includes(ticket.status);

  if (isActive === (conversation.ticketId === ticket.id)) {
    return;
  }

  state.conversations.set(conversation.id, {
    ...conversation,
    ticketId: isActive ? ticket.id : null,
  });
}

/**
 * `priority DESC, createdAt DESC, id DESC`.
 *
 * `orderIndex` reads the position in `TICKET_PRIORITIES`, which is declared
 * `low, normal, high, urgent` — the same declaration order Postgres sorts the
 * enum by. Reordering that array silently inverts the queue, which is why the
 * dependency is named here rather than assumed.
 */
function byQueueOrder(left: MockTicket, right: MockTicket): number {
  return (
    orderIndex(right.priority) - orderIndex(left.priority) ||
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

function orderIndex(priority: MockTicket['priority']): number {
  return TICKET_PRIORITIES.indexOf(priority);
}

/**
 * `routing_deferred_since ASC, id ASC` — the flagged queue, oldest stuck first
 * (ADR 0008 decision 3, amendment 3).
 *
 * The id tie-break is not decoration: the API pages this order on a keyset and
 * one column is not a total order, so two tickets deferred in the same
 * millisecond would straddle a page boundary and one would be dropped. Mirroring
 * it here keeps a mock-mode page in the same order a real one arrives in.
 *
 * `deferredSince` is nullable on the wire and never null in this order's input:
 * every caller of it has filtered to the deferred set, where the API's `CHECK`
 * makes the column non-null. The `?? ''` is what a fixture that broke that would
 * sort as — first, and visibly — rather than a crash in a comparator.
 */
function byFlaggedOrder(left: MockTicket, right: MockTicket): number {
  return (
    (left.routing.deferredSince ?? '').localeCompare(right.routing.deferredSince ?? '') ||
    left.id.localeCompare(right.id)
  );
}

function isTicketAssignedTo(ticket: MockTicket, principal: SessionPrincipal): boolean {
  return (
    ticket.assignedUserId === principal.userId ||
    (ticket.assignedTeamId !== null && principal.teamIds.includes(ticket.assignedTeamId))
  );
}

/**
 * Mirrors the API's `narrowScope(scope, principal, 'ticket:read_all')`: a caller
 * without the permission gets their own and their teams' tickets whatever scope
 * they asked for, rather than a refusal — so a supervisor's shared link still
 * renders for an agent, with less in it.
 */
function matchesTicketScope(
  ticket: MockTicket,
  scope: TicketListQuery['scope'],
  principal: SessionPrincipal,
): boolean {
  if (!roleHasPermission(principal.role, 'ticket:read_all')) {
    return isTicketAssignedTo(ticket, principal);
  }

  if (scope === 'assigned') {
    return isTicketAssignedTo(ticket, principal);
  }

  if (scope === 'unassigned') {
    return ticket.assignedUserId === null && ticket.assignedTeamId === null;
  }

  return true;
}

/**
 * The API's `isVisible` — **not** `isVisibleOrUnclaimed`. Tickets keep the narrow
 * rule: an unassigned ticket is triaged work, not something every agent may pick
 * up, so it is visible only to a principal holding `ticket:read_all`.
 *
 * A ticket outside that set answers `not_found`, never `forbidden`, on the PATCH
 * exactly as on the GET.
 */
function findTicketInTenant(principal: SessionPrincipal, id: string | undefined): MockTicket {
  const ticket = tenantTickets(principal).find((candidate) => candidate.id === id);

  if (ticket === undefined) {
    throw notFound();
  }

  if (
    !roleHasPermission(principal.role, 'ticket:read_all') &&
    !isTicketAssignedTo(ticket, principal)
  ) {
    throw notFound();
  }

  return ticket;
}

// --- SLA alerts (TAR-26, ADR 0006) -----------------------------------------

/**
 * `GET /v1/sla-alerts` — the supervisor's own breaches.
 *
 * Two narrowings, both of which the console's role-scoping claim rests on, so
 * both are modelled rather than assumed:
 *
 *   1. **Tenant**, like every other read here.
 *   2. **Recipient.** `recipient_user_id = principal.userId`, on top of the
 *      tenant filter. The fixtures seed Priya's and Omar's own copies of the
 *      same breach precisely so a handler that forgot this would fail a test.
 *
 * Newest first, which is the keyset order the index in ADR 0006 serves.
 */
function listSlaAlerts({ principal, query }: RouteContext): CursorPage<SlaAlertResponse> {
  const parsed = SlaAlertListQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const { unacknowledgedOnly, limit } = parsed.data;

  const items = principalAlerts(principal)
    .filter((alert) => !unacknowledgedOnly || alert.acknowledgedAt === null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit)
    .map(toSlaAlertResponse);

  return { items, nextCursor: null };
}

/**
 * `POST /v1/sla-alerts/{id}/acknowledge`.
 *
 * **Idempotent, and modelled as such**: a second call returns the same row with
 * its original `acknowledgedAt` rather than a 409. The panel's optimistic
 * removal is only safe to retry because of that, so a fixture layer that
 * answered `conflict` would let a bug through review.
 *
 * Another principal's alert answers `not_found`, never `forbidden` — a 403 would
 * confirm the id exists (0002's rule).
 */
function acknowledgeSlaAlert({ principal, params }: RouteContext): SlaAlertResponse {
  const alert = principalAlerts(principal).find((candidate) => candidate.id === params[0]);

  if (alert === undefined) {
    throw notFound();
  }

  if (alert.acknowledgedAt !== null) {
    return toSlaAlertResponse(alert);
  }

  const updated: MockSlaAlert = { ...alert, acknowledgedAt: new Date().toISOString() };

  mockState().slaAlerts.set(updated.id, updated);

  return toSlaAlertResponse(updated);
}

/** This tenant's alerts, addressed to this principal. Never one without the other. */
function principalAlerts(principal: SessionPrincipal): MockSlaAlert[] {
  return [...mockState().slaAlerts.values()].filter(
    (alert) => alert.tenantId === principal.tenantId && alert.recipientUserId === principal.userId,
  );
}

/** `recipientUserId` never crosses the wire — the API narrows instead of publishing it. */
function toSlaAlertResponse(alert: MockSlaAlert): SlaAlertResponse {
  const { recipientUserId, ...scoped } = stripTenant(alert);

  if (recipientUserId.length === 0) {
    throw new Error('Mock SLA alert is missing its recipient.');
  }

  return scoped;
}

// --- Sending, and the templates that survive a closed window (TAR-20g) ------

/**
 * `POST /v1/conversations/{id}/messages`.
 *
 * The three refusals the composer is built around, all of them reachable here so
 * the console's branches can be walked without an API:
 *
 *   * a missing or malformed `Idempotency-Key` — `validation_failed`;
 *   * a key already spent on a *different* body — `idempotency_key_reused`,
 *     which is what an agent editing a draft and retrying with a stale key would
 *     hit if the composer did not mint a new one;
 *   * a free-form send outside the 24-hour window — `whatsapp_window_expired`.
 *
 * Replaying the same key with the same body returns the original message rather
 * than sending again. That is the guarantee the Send button's double-click
 * protection rests on, so it is modelled rather than assumed.
 */
function sendMessage({ principal, params, body, headers }: RouteContext): MessageResponse {
  const conversation = findConversationInTenant(principal, params[0]);
  const idempotencyKey = headers[IDEMPOTENCY_KEY_HEADER];

  if (idempotencyKey === undefined || !IdSchema.safeParse(idempotencyKey).success) {
    throw validationFailed();
  }

  assertHeld(conversation);

  const parsed = SendMessageInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const input = parsed.data;
  const payload = JSON.stringify(input);
  const state = mockState();
  const spent = state.sentByIdempotencyKey.get(idempotencyKey);

  if (spent !== undefined) {
    if (spent.payload !== payload) {
      throw refused(
        'idempotency_key_reused',
        'That idempotency key was already used for a different message.',
        HTTP_UNPROCESSABLE,
      );
    }

    return toMessageResponse(spent.message);
  }

  if (input.type !== 'template' && !isServiceWindowOpen(conversation)) {
    throw refused(
      'whatsapp_window_expired',
      'This conversation is outside its 24-hour window. Send an approved template instead.',
      HTTP_UNPROCESSABLE,
    );
  }

  const sentAt = new Date().toISOString();
  const created: MockMessage = {
    tenantId: principal.tenantId,
    id: nextMockId(),
    conversationId: conversation.id,
    direction: 'outbound',
    type: input.type,
    // Every send starts here: the row is committed and the Cloud API call is
    // queued behind it. In the real system the ladder that follows arrives over
    // the socket; nothing in mock mode advances it, and that is honest — there
    // is no Meta to report a delivery.
    status: 'queued',
    body: sentBody(principal, input),
    // No media object store here, so an outbound attachment cannot be
    // reconstructed. The thread renders the labelled placeholder for its type
    // rather than a broken image.
    attachments: [],
    sentByUserId: principal.userId,
    sentByAutomation: false,
    providerMessageId: null,
    failureReason: null,
    sentAt,
    createdAt: sentAt,
  };

  state.messages.set(created.id, created);
  state.sentByIdempotencyKey.set(idempotencyKey, { payload, message: created });
  state.conversations.set(conversation.id, {
    ...conversation,
    lastMessageAt: sentAt,
    lastMessagePreview: created.body,
    updatedAt: sentAt,
  });

  return toMessageResponse(created);
}

/**
 * What the thread will show for this send.
 *
 * A template's body is the approved copy with the variables substituted in,
 * through the contract's own renderer — the same one the real send path stores,
 * so the mock thread and the real one cannot disagree about what was said.
 */
function sentBody(principal: SessionPrincipal, input: SendMessageInput): string | null {
  if (input.type === 'text') {
    return input.body;
  }

  if (input.type !== 'template') {
    return input.caption ?? null;
  }

  const found = tenantTemplates(principal).find(
    (candidate) =>
      candidate.name === input.templateName && candidate.language === input.languageCode,
  );

  if (found === undefined) {
    throw refused(
      'whatsapp_template_invalid',
      'That template is not approved for this number.',
      HTTP_BAD_REQUEST,
    );
  }

  if (input.variables.length !== found.parameterCount) {
    throw refused(
      'whatsapp_template_invalid',
      `That template takes ${String(found.parameterCount)} value(s) and ${String(input.variables.length)} were supplied.`,
      HTTP_BAD_REQUEST,
    );
  }

  // The rule 0002 amendment 1 states: a header exactly when the template
  // publishes one, and the two formats must agree.
  if ((input.header?.format ?? null) !== found.headerFormat) {
    throw refused(
      'whatsapp_template_invalid',
      'That template’s header does not match the one supplied.',
      HTTP_BAD_REQUEST,
    );
  }

  return renderTemplateBody(found.bodyText, input.variables);
}

/**
 * `GET /v1/message-templates` — approved and sendable only, ordered by name then
 * language, exactly as the endpoint documents.
 *
 * `whatsappAccountId` is a phone number and the server resolves its WABA. The
 * fixtures hold one number and one business account, so filtering by it can only
 * narrow to nothing or to everything — it is still validated, because a caller
 * naming an unknown number gets `validation_failed` from the real endpoint and
 * the console must not be surprised by that.
 */
function listMessageTemplates({
  principal,
  query,
}: RouteContext): CursorPage<MessageTemplateResponse> {
  const parsed = MessageTemplateListQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const { whatsappAccountId, q, limit } = parsed.data;

  if (whatsappAccountId !== undefined && whatsappAccountId !== MOCK_IDS.whatsappAccount) {
    throw refused('validation_failed', 'Unknown WhatsApp number.', HTTP_UNPROCESSABLE);
  }

  const prefix = q?.trim().toLowerCase();

  const items = tenantTemplates(principal)
    .filter((item) => prefix === undefined || item.name.toLowerCase().startsWith(prefix))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.language.localeCompare(right.language),
    )
    .slice(0, limit)
    .map(toMessageTemplateResponse);

  return { items, nextCursor: null };
}

/** Mirrors the API's window rule: `null` is closed, and the boundary is exclusive. */
function isServiceWindowOpen(conversation: MockConversation): boolean {
  return (
    conversation.serviceWindowExpiresAt !== null &&
    Date.parse(conversation.serviceWindowExpiresAt) > Date.now()
  );
}

function isUnclaimed(conversation: MockConversation): boolean {
  return conversation.assignedUserId === null && conversation.assignedTeamId === null;
}

/**
 * The API's `requireHeld`, mirrored: the shared pool is readable by every agent
 * and writable by none, so a send, a note or a status change into it is refused
 * until somebody claims the thread (TAR-186).
 *
 * Modelled rather than assumed, because it is what the console's shut composer
 * is claiming to be true — a mock that let the write through would let a
 * regression in that gate ship looking fine.
 */
function assertHeld(conversation: MockConversation): void {
  if (isUnclaimed(conversation)) {
    throw refused(
      'conflict',
      'Claim this conversation before replying to it — nobody is holding it yet.',
      HTTP_CONFLICT,
    );
  }
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

function tenantTickets(principal: SessionPrincipal): MockTicket[] {
  return [...mockState().tickets.values()].filter(
    (ticket) => ticket.tenantId === principal.tenantId,
  );
}

function tenantTemplates(principal: SessionPrincipal): MockMessageTemplate[] {
  return [...mockState().messageTemplates.values()].filter(
    (item) => item.tenantId === principal.tenantId,
  );
}

function tenantTags(principal: SessionPrincipal): MockTag[] {
  return [...mockState().tags.values()].filter((tag) => tag.tenantId === principal.tenantId);
}

function tenantCustomFieldDefinitions(principal: SessionPrincipal): MockCustomFieldDefinition[] {
  return [...mockState().customFieldDefinitions.values()].filter(
    (definition) => definition.tenantId === principal.tenantId,
  );
}

function tenantRules(principal: SessionPrincipal): MockAssignmentRule[] {
  return [...mockState().assignmentRules.values()].filter(
    (rule) => rule.tenantId === principal.tenantId,
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

function findRuleInTenant(principal: SessionPrincipal, id: string | undefined): MockAssignmentRule {
  const rule = tenantRules(principal).find((candidate) => candidate.id === id);

  if (rule === undefined) {
    throw notFound();
  }

  return rule;
}

function orderedTenantRules(principal: SessionPrincipal): MockAssignmentRule[] {
  return tenantRules(principal).sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

function nextRulePosition(existing: readonly MockAssignmentRule[]): number {
  return existing.reduce((highest, rule) => Math.max(highest, rule.position + 1), 0);
}

/** Keeps `position` dense after a move, so the next move is never a no-op. */
function renumberTenantRules(principal: SessionPrincipal): void {
  const state = mockState();

  orderedTenantRules(principal).forEach((rule, index) => {
    state.assignmentRules.set(rule.id, { ...rule, position: index });
  });
}

/**
 * `UNIQUE (tenant_id, name)` on a citext column: two rules called `Billing` and
 * `billing` are indistinguishable in the ticket event log that records why a
 * ticket was routed, so the comparison is case-insensitive here too.
 */
function assertRuleNameFree(
  existing: readonly MockAssignmentRule[],
  name: string,
  ownRuleId: string | null,
): void {
  const candidate = name.trim().toLowerCase();
  const taken = existing.some(
    (rule) => rule.id !== ownRuleId && rule.name.toLowerCase() === candidate,
  );

  if (taken) {
    throw refused('conflict', 'A rule with that name already exists.', HTTP_CONFLICT);
  }
}

function ruleLimitReached(): ApiRequestError {
  return refused(
    'conflict',
    `A workspace can hold ${String(ROUTING_RULE_LIMITS.rulesPerTenant)} routing rules.`,
    HTTP_CONFLICT,
  );
}

/**
 * A target in another tenant is `validation_failed`, not `not_found`: row-level
 * security means the id is simply not visible, so the server cannot tell "another
 * tenant's team" from "no such team" — and that indistinguishability is the point.
 */
function assertTargetInTenant(principal: SessionPrincipal, target: RoutingTarget): void {
  const exists =
    target.kind === 'team'
      ? tenantTeams(principal).some((team) => team.id === target.teamId)
      : tenantUsers(principal).some((user) => user.id === target.userId);

  if (!exists) {
    throw refused(
      'validation_failed',
      'That target is not a team or agent in this workspace.',
      HTTP_UNPROCESSABLE,
    );
  }
}

/**
 * Every id and key a condition names has to resolve inside the caller's tenant.
 * Same reasoning as the target: refusing here is what stops a rule quietly
 * referencing another tenant's tag, and the refusal names the field without
 * confirming whether the id exists elsewhere.
 */
function assertConditionsResolvable(
  principal: SessionPrincipal,
  conditions: readonly RoutingCondition[],
): void {
  const tagIds = new Set(tenantTags(principal).map((tag) => tag.id));
  const fieldKeys = new Set(
    tenantCustomFieldDefinitions(principal).map((definition) => definition.key),
  );

  for (const condition of conditions) {
    if (condition.type === 'tag' && !condition.tagIds.every((id) => tagIds.has(id))) {
      throw refused('validation_failed', 'That tag is not in this workspace.', HTTP_UNPROCESSABLE);
    }

    if (condition.type === 'contact_attribute' && !fieldKeys.has(condition.key)) {
      throw refused(
        'validation_failed',
        'That contact field is not in this workspace.',
        HTTP_UNPROCESSABLE,
      );
    }
  }
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

function toTagResponse(tag: MockTag): Tag {
  return stripTenant(tag);
}

function toCustomFieldDefinitionResponse(
  definition: MockCustomFieldDefinition,
): CustomFieldDefinition {
  return stripTenant(definition);
}

function toAssignmentRuleResponse(rule: MockAssignmentRule): AssignmentRuleResponse {
  return stripTenant(rule);
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

function toMessageTemplateResponse(item: MockMessageTemplate): MessageTemplateResponse {
  return stripTenant(item);
}

function toTicketResponse(ticket: MockTicket): TicketResponse {
  return stripTenant(ticket);
}

// --- Helpers ---------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 25;
const MOCK_CREATED_AT = '2026-08-10T12:00:00.000Z';
/** A literal, like every other timestamp here — `Date.now()` would break hydration. */
const MOCK_UPDATED_AT = '2026-08-12T12:00:00.000Z';

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
