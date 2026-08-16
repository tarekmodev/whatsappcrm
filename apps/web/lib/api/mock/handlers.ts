import 'server-only';

import {
  AI_CONFIG_DEFAULTS,
  AI_MODEL_CATALOG,
  AssignmentRuleCreateInputSchema,
  AssignmentRuleReorderInputSchema,
  AssignmentRuleUpdateInputSchema,
  BRANDING_ASSET_LIMITS,
  BRANDING_UPLOAD_FIELD,
  BrandingAssetKindSchema,
  CUSTOM_FIELD_LIMITS,
  ContactListQuerySchema,
  ContactUpdateInputSchema,
  ConversationAssignInputSchema,
  CreateKnowledgeDocumentInputSchema,
  ConversationListQuerySchema,
  ConversationStatusUpdateInputSchema,
  CursorPageQuerySchema,
  CustomFieldDefinitionCreateInputSchema,
  CustomFieldDefinitionUpdateInputSchema,
  DashboardExportQuerySchema,
  DashboardMetricsQuerySchema,
  IdSchema,
  InternalNoteCreateInputSchema,
  InviteCreateInputSchema,
  KNOWLEDGE_DOCUMENT_LIMITS,
  KnowledgeDocumentListItemSchema,
  KnowledgeDocumentListQuerySchema,
  MAX_CUSTOM_DOMAINS_PER_TENANT,
  MessageListQuerySchema,
  MessageTemplateListQuerySchema,
  ONBOARDING_STEP_IDS,
  OnboardingStepUpdateInputSchema,
  ROUTING_RULE_LIMITS,
  PasswordChangeInputSchema,
  PasswordResetConfirmInputSchema,
  PasswordResetRequestInputSchema,
  RequestHandoffInputSchema,
  SendMessageInputSchema,
  SlaAlertListQuerySchema,
  TICKET_ACTIVE_STATUSES,
  TICKET_PRIORITIES,
  TICKET_STATUS_REQUIRES_CLOSE,
  TeamCreateInputSchema,
  TeamUpdateInputSchema,
  TenantDomainCreateInputSchema,
  TenantUpdateInputSchema,
  TicketAssignInputSchema,
  TicketEscalateInputSchema,
  TicketEventListQuerySchema,
  TicketListQuerySchema,
  TicketUpdateInputSchema,
  UpdateAiConfigInputSchema,
  UpdateKnowledgeDocumentInputSchema,
  UserListQuerySchema,
  UserUpdateInputSchema,
  WORKFLOW_LIMITS,
  WhatsAppEmbeddedSignupInputSchema,
  WorkflowCreateInputSchema,
  WorkflowReorderInputSchema,
  WorkflowTestInputSchema,
  WorkflowUpdateInputSchema,
  brandingAssetPath,
  canAgentTransition,
  customFieldValueIssue,
  isRoleWithin,
  isSlaBreached,
  renderTemplateBody,
  roleHasPermission,
  ticketAssignRequiresReason,
  whatsAppSignupFailureDetails,
  workflowCatalog,
  type AiConfigResponse,
  type AiReadiness,
  type AiReadinessBlocker,
  type ApiError,
  type AssignmentRuleListResponse,
  type AssignmentRuleResponse,
  type CannedResponseListResponse,
  type CannedResponseResponse,
  type ConnectedWhatsAppBusinessAccountResponse,
  type ContactResponse,
  type ConversationResponse,
  type CursorPage,
  type CustomFieldDefinition,
  type DashboardMetricsResponse,
  type HandoffContextResponse,
  type InternalNoteResponse,
  type KnowledgeDocumentListItem,
  type KnowledgeDocumentResponse,
  type MessageResponse,
  type MessageTemplateResponse,
  type OnboardingChecklistResponse,
  type OnboardingStepId,
  type Permission,
  type RoutingCondition,
  type RoutingTarget,
  type SendMessageInput,
  type SessionPrincipal,
  type SessionResponse,
  type SlaAlertResponse,
  type Tag,
  type TeamResponse,
  type TenantBranding,
  type TenantDomain,
  type TenantDomainListResponse,
  type TenantLifecycleResponse,
  type TenantPublicResponse,
  type TenantResponse,
  type TicketEscalationResponse,
  type TicketEvent,
  type TicketListQuery,
  type TicketResponse,
  type UserResponse,
  type WorkflowAction,
  type WorkflowCatalogResponse,
  type WorkflowCondition,
  type WorkflowListResponse,
  type WorkflowReference,
  type WorkflowResponse,
  type WorkflowRunResponse,
  type WorkflowTaxonomyKind,
  type WorkflowTestResponse,
} from '@whatsappcrm/contracts';
import { ApiRequestError, type ApiRequest } from '@/lib/api/http';
import { dashboardMetrics } from '@/lib/api/mock/reporting';
import { dashboardCsv } from '@/lib/api/mock/report-csv';
import { mockState, nextMockId } from '@/lib/api/mock/store';
import { MOCK_IDS } from '@/lib/api/mock/fixtures';
import type {
  MockAiConfigRecord,
  MockAssignmentRule,
  MockCannedResponse,
  MockContact,
  MockConversation,
  MockCustomFieldDefinition,
  MockHandoffRecord,
  MockInternalNote,
  MockKnowledgeDocument,
  MockMessage,
  MockMessageTemplate,
  MockOnboardingChecklist,
  MockSlaAlert,
  MockTag,
  MockTeam,
  MockTenantDomain,
  MockTicket,
  MockTicketEvent,
  MockUser,
  MockWorkflow,
  MockWorkflowRun,
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
    // Read only. 0011 decision 1 has the console hold the whole set and match a
    // typed shortcut locally, so this is the one route the composer needs; the
    // writes belong to a settings screen that does not exist yet, and a mock
    // route with no caller is a route nobody would notice going wrong.
    method: 'GET',
    pattern: /^\/v1\/canned-responses$/,
    permission: 'canned_response:read',
    handle: listCannedResponses,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows$/,
    permission: 'workflow:read',
    handle: listWorkflows,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workflows$/,
    permission: 'workflow:write',
    handle: createWorkflow,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workflows\/reorder$/,
    permission: 'workflow:write',
    handle: reorderWorkflows,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/v1/workflows/${UUID_SEGMENT}$`),
    permission: 'workflow:read',
    handle: getWorkflow,
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/v1/workflows/${UUID_SEGMENT}$`),
    permission: 'workflow:write',
    handle: updateWorkflow,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/v1/workflows/${UUID_SEGMENT}$`),
    permission: 'workflow:write',
    handle: deleteWorkflow,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/workflows/${UUID_SEGMENT}/test$`),
    // `workflow:write`, not `workflow:read`: the dry run reports facts about one
    // ticket, and reporting them to somebody whose ticket scope does not reach it
    // would be a read-scope bypass (ADR 0009 — `POST /test`).
    permission: 'workflow:write',
    handle: testWorkflow,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/v1/workflows/${UUID_SEGMENT}/runs$`),
    permission: 'workflow:read',
    handle: listWorkflowRuns,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflow-catalog$/,
    permission: 'workflow:read',
    handle: getWorkflowCatalog,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/tags$/,
    permission: 'contact:read',
    handle: listTags,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/contacts$/,
    permission: 'contact:read',
    handle: listContacts,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/v1/contacts/${UUID_SEGMENT}$`),
    permission: 'contact:read',
    handle: getContact,
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/v1/contacts/${UUID_SEGMENT}$`),
    permission: 'contact:write',
    handle: updateContact,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/custom-fields$/,
    permission: 'contact:read',
    handle: listCustomFieldDefinitions,
  },
  {
    // `tenant:settings` to mutate, `contact:read` to list — 0002 amendment 10.
    // `contact:write` deliberately cannot carry the write half: every agent
    // holds it, which is TAR-33's criterion inverted.
    method: 'POST',
    pattern: /^\/v1\/custom-fields$/,
    permission: 'tenant:settings',
    handle: createCustomFieldDefinition,
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/v1/custom-fields/${UUID_SEGMENT}$`),
    permission: 'tenant:settings',
    handle: updateCustomFieldDefinition,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/v1/custom-fields/${UUID_SEGMENT}$`),
    permission: 'tenant:settings',
    handle: deleteCustomFieldDefinition,
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
    method: 'GET',
    pattern: new RegExp(`^/v1/tickets/${UUID_SEGMENT}/events$`),
    // `ticket:read`, and the ticket goes through the same visibility rule the
    // GET does — the event log inherits the ticket's rule exactly rather than
    // becoming a side channel onto one the principal may not open.
    permission: 'ticket:read',
    handle: listTicketEvents,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/tickets/${UUID_SEGMENT}/assign$`),
    // The **weaker** of the two, per ADR 0011 decision 2: every role may hand
    // off a ticket they hold, and `assertTicketHandoffAllowed` applies the bound
    // that `ticket:assign` skips. A route whose declared permission is weaker
    // than one of its behaviours is where authorization bugs live, so the bound
    // is modelled here rather than assumed of the API.
    permission: 'ticket:handoff',
    handle: assignTicket,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/tickets/${UUID_SEGMENT}/escalate$`),
    permission: 'ticket:escalate',
    handle: escalateTicket,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/reports\/dashboard$/,
    // `report:read`, which every role holds. What a supervisor holds on top is
    // `report:read_all`, and that widens the aggregate rather than deciding
    // whether the call is allowed — so it is checked inside the aggregation,
    // never here (ADR 0009 decision 6).
    permission: 'report:read',
    handle: reportDashboard,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/reports\/dashboard\/export$/,
    // The same permission as the JSON route, deliberately: the export is a
    // representation of that resource, not a wider one (ADR 0009 decision 1).
    permission: 'report:read',
    handle: reportDashboardExport,
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
  // --- Tenant, branding and domains (TAR-29) -------------------------------
  {
    method: 'GET',
    // Unauthenticated by design: the sign-in screen has to be branded before
    // anybody has a session. It takes no parameters — the *host* names the
    // tenant, and an identifier on this route would be an enumeration oracle.
    pattern: /^\/v1\/tenant\/public$/,
    permission: null,
    handle: getPublicTenant,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/tenant$/,
    // Any signed-in principal: the shell reads its own tenant's name.
    permission: null,
    handle: getTenant,
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/tenant$/,
    permission: 'branding:write',
    handle: updateTenant,
  },
  {
    method: 'PUT',
    pattern: /^\/v1\/tenant\/branding\/(logo|favicon)$/,
    permission: 'branding:write',
    handle: putBrandingAsset,
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/tenant\/branding\/(logo|favicon)$/,
    permission: 'branding:write',
    handle: deleteBrandingAsset,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/tenant\/domains$/,
    permission: 'domain:write',
    handle: listTenantDomains,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/tenant\/domains$/,
    permission: 'domain:write',
    handle: createTenantDomain,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/tenant/domains/${UUID_SEGMENT}/verify$`),
    permission: 'domain:write',
    handle: verifyTenantDomain,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/tenant/domains/${UUID_SEGMENT}/primary$`),
    permission: 'domain:write',
    handle: setPrimaryTenantDomain,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/v1/tenant/domains/${UUID_SEGMENT}$`),
    permission: 'domain:write',
    handle: deleteTenantDomain,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/tenant$/,
    // Gated by no permission, matching ADR 0002's table: the workspace's own
    // name and branding are what every signed-in principal already sees in the
    // chrome around them.
    permission: null,
    handle: getTenant,
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/tenant$/,
    permission: 'branding:write',
    handle: updateTenant,
  },
  {
    // Grouped with the two above rather than interleaved with the onboarding
    // pair below only for a reader's benefit — every pattern here is anchored,
    // so no ordering between them can change which one matches.
    method: 'GET',
    pattern: /^\/v1\/tenant\/lifecycle$/,
    permission: 'tenant:settings',
    handle: getTenantLifecycle,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/tenant\/onboarding$/,
    permission: 'tenant:settings',
    handle: readOnboardingChecklist,
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/v1/tenant/onboarding/steps/(${ONBOARDING_STEP_IDS.join('|')})$`),
    permission: 'tenant:settings',
    handle: updateOnboardingStep,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/knowledge-documents$/,
    permission: 'ai:read',
    handle: listKnowledgeDocuments,
  },
  {
    method: 'POST',
    pattern: /^\/v1\/knowledge-documents$/,
    permission: 'ai:write',
    handle: createKnowledgeDocument,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/v1/knowledge-documents/${UUID_SEGMENT}$`),
    permission: 'ai:read',
    handle: getKnowledgeDocument,
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/v1/knowledge-documents/${UUID_SEGMENT}$`),
    permission: 'ai:write',
    handle: updateKnowledgeDocument,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/v1/knowledge-documents/${UUID_SEGMENT}$`),
    permission: 'ai:write',
    handle: deleteKnowledgeDocument,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/knowledge-documents/${UUID_SEGMENT}/reindex$`),
    permission: 'ai:write',
    handle: reindexKnowledgeDocument,
  },
  {
    method: 'GET',
    pattern: /^\/v1\/ai\/config$/,
    // `ai:read` and **no feature gate**: a tenant whose plan lacks `ai_chatbot`
    // reads the config so the console can render an upsell rather than a 403
    // page (ADR 0010). The `PATCH` below is the one that refuses.
    permission: 'ai:read',
    handle: getAiConfig,
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/ai\/config$/,
    permission: 'ai:write',
    handle: updateAiConfig,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/v1/conversations/${UUID_SEGMENT}/handoff$`),
    // `conversation:read` plus the same visibility rule the thread uses, so this
    // cannot expose a conversation the principal could not already open. Not
    // `ai:read`, which is admin-only — the agent reading the summary is exactly
    // who it is for.
    permission: 'conversation:read',
    handle: getHandoffContext,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/v1/conversations/${UUID_SEGMENT}/handoff$`),
    permission: 'conversation:claim',
    handle: requestHandoff,
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
  // Onboarding's "invite your agents" is done because somebody was invited, not
  // because a checklist was ticked. See `completeOnboardingStep`.
  completeOnboardingStep(principal.tenantId, 'invite_agents');

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

// --- Canned responses (TAR-31, contract 0011) ------------------------------
//
// Read only, and deliberately so: the composer expands a shortcut, and nothing
// in the console writes one yet.

function listCannedResponses({ principal }: RouteContext): CannedResponseListResponse {
  // Ascending `shortcut`, as the API orders it — the picker ranks what it is
  // given, so a transport that returned them unordered would flatter it.
  const items = [...mockState().cannedResponses.values()]
    .filter((response) => response.tenantId === principal.tenantId)
    .sort((left, right) => left.shortcut.localeCompare(right.shortcut))
    .map(toCannedResponseResponse);

  return { items, nextCursor: null };
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

// --- Workflows (TAR-27, ADR 0009) ------------------------------------------

/**
 * The automation surface ADR 0009 publishes, standing in until TAR-395 ships it.
 *
 * Deliberately not a permissive stub. It enforces the refusals the console has
 * to render — duplicate name, the two per-tenant caps, a reference that names
 * another tenant's row, arming a workflow whose references no longer resolve,
 * and a reorder that lost a race — because a fixture layer that said yes to all
 * of those would let every one of them through review.
 *
 * The one behaviour worth reading twice is `workflowReferences`: it is computed
 * from the definition's ids against live rows on **every read**, never stored.
 * That is TAR-27's second acceptance criterion made structural rather than
 * asserted — renaming a tag here changes the workflow's rendering with no write
 * to the workflow at all, and deleting one shows as `exists: false`.
 */

function listWorkflows({ principal }: RouteContext): WorkflowListResponse {
  return workflowList(principal);
}

/** `ORDER BY position ASC, id ASC` — 0009 decision 4's execution order. */
function workflowList(principal: SessionPrincipal): WorkflowListResponse {
  return {
    items: orderedTenantWorkflows(principal).map((workflow) =>
      toWorkflowResponse(principal, workflow),
    ),
    nextCursor: null,
  };
}

function getWorkflow({ principal, params }: RouteContext): WorkflowResponse {
  return toWorkflowResponse(principal, findWorkflowInTenant(principal, params[0]));
}

/**
 * Derived from the contract's own constants rather than transcribed, so the mock
 * and TAR-395's implementation cannot disagree about what the builder may offer
 * — 0009's "the mock and the implementation are generated from the same source".
 */
function getWorkflowCatalog(): WorkflowCatalogResponse {
  return workflowCatalog();
}

function createWorkflow({ principal, body }: RouteContext): WorkflowResponse {
  const parsed = WorkflowCreateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { name, trigger, conditions, actions, position, isActive } = parsed.data;
  const existing = orderedTenantWorkflows(principal);

  if (existing.length >= WORKFLOW_LIMITS.workflowsPerTenant) {
    // `conflict`, not `plan_limit_exceeded`: the cap is a property of the engine,
    // not of the tenant's plan, and money cannot fix it.
    throw workflowLimitReached();
  }

  assertWorkflowNameFree(existing, name, null);
  assertElapsedTriggerRoom(existing, trigger, null);
  assertWorkflowReferencesInTenant(principal, conditions, actions);

  const created: MockWorkflow = {
    tenantId: principal.tenantId,
    id: nextMockId(),
    name: name.trim(),
    position: position ?? nextWorkflowPosition(existing),
    isActive,
    brokenReason: null,
    version: 1,
    trigger,
    conditions: [...conditions],
    actions: [...actions],
    createdAt: MOCK_CREATED_AT,
    updatedAt: MOCK_CREATED_AT,
  };

  assertArmable(principal, created, isActive);
  mockState().workflows.set(created.id, created);

  return toWorkflowResponse(principal, created);
}

function updateWorkflow({ principal, params, body }: RouteContext): WorkflowResponse {
  const workflow = findWorkflowInTenant(principal, params[0]);
  const parsed = WorkflowUpdateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { name, trigger, conditions, actions, position, isActive } = parsed.data;

  if (name !== undefined) {
    assertWorkflowNameFree(orderedTenantWorkflows(principal), name, workflow.id);
  }

  if (trigger !== undefined) {
    assertElapsedTriggerRoom(orderedTenantWorkflows(principal), trigger, workflow.id);
  }

  assertWorkflowReferencesInTenant(principal, conditions ?? [], actions ?? []);

  // `version` tracks what *runs*: renaming or reordering changes nothing about
  // execution, so it does not bump (ADR 0009 — `PATCH /workflows/{id}`).
  const changesDefinition =
    trigger !== undefined || conditions !== undefined || actions !== undefined;

  const updated: MockWorkflow = {
    ...workflow,
    name: name?.trim() ?? workflow.name,
    trigger: trigger ?? workflow.trigger,
    conditions: conditions === undefined ? workflow.conditions : [...conditions],
    actions: actions === undefined ? workflow.actions : [...actions],
    position: position ?? workflow.position,
    isActive: isActive ?? workflow.isActive,
    version: changesDefinition ? workflow.version + 1 : workflow.version,
    updatedAt: MOCK_UPDATED_AT,
  };

  assertArmable(principal, updated, isActive);

  // A workflow whose references all resolve again is no longer broken. Clearing
  // this is what lets the supervisor arm it after replacing the missing target —
  // the CHECK `NOT is_active OR broken_reason IS NULL` depends on it.
  const stored: MockWorkflow = {
    ...updated,
    brokenReason: workflowReferences(principal, updated).every((reference) => reference.exists)
      ? null
      : updated.brokenReason,
  };

  mockState().workflows.set(stored.id, stored);

  if (position !== undefined) {
    renumberTenantWorkflows(principal);
  }

  return toWorkflowResponse(principal, findWorkflowInTenant(principal, stored.id));
}

/**
 * Takes the tenant's **complete** workflow set in execution order and rewrites
 * `position` to the array index. A submitted set that is not exactly the current
 * one means somebody else created or deleted a workflow since this client
 * loaded, so it answers `conflict` rather than performing a partial reorder.
 */
function reorderWorkflows({ principal, body }: RouteContext): WorkflowListResponse {
  const parsed = WorkflowReorderInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { workflowIds } = parsed.data;
  const submitted = new Set(workflowIds);

  if (submitted.size !== workflowIds.length) {
    throw refused('validation_failed', 'A workflow was listed twice.', HTTP_UNPROCESSABLE);
  }

  const current = orderedTenantWorkflows(principal);

  if (current.length !== workflowIds.length || !current.every((item) => submitted.has(item.id))) {
    throw refused(
      'conflict',
      'The workflow list changed while you were reordering it. Reload and try again.',
      HTTP_CONFLICT,
    );
  }

  const state = mockState();

  workflowIds.forEach((id, index) => {
    const workflow = findWorkflowInTenant(principal, id);

    state.workflows.set(id, { ...workflow, position: index, updatedAt: MOCK_UPDATED_AT });
  });

  return workflowList(principal);
}

/** 204 either way: deleting an already-deleted workflow is not an error. */
function deleteWorkflow({ principal, params }: RouteContext): null {
  const id = params[0];
  const workflow = orderedTenantWorkflows(principal).find((candidate) => candidate.id === id);

  if (workflow !== undefined) {
    const state = mockState();

    state.workflows.delete(workflow.id);

    // `workflow_runs` cascade on the workflow's delete.
    for (const run of state.workflowRuns.values()) {
      if (run.workflowId === workflow.id) {
        state.workflowRuns.delete(run.id);
      }
    }
  }

  return null;
}

/**
 * `GET /v1/workflows/{id}/runs` — newest first, and it pages: runs grow with
 * ticket volume, which is the unbounded set the pagination rule exists for.
 */
function listWorkflowRuns({
  principal,
  params,
  query,
}: RouteContext): CursorPage<WorkflowRunResponse> {
  const workflow = findWorkflowInTenant(principal, params[0]);
  const parsed = CursorPageQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const matched = tenantWorkflowRuns(principal)
    .filter((run) => run.workflowId === workflow.id)
    // `(created_at DESC, id DESC)`, the keyset the API pages on. The id
    // tie-break is not decoration: two runs claimed in the same millisecond
    // would otherwise straddle a page boundary and one would be dropped.
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );

  const items = matched.slice(0, parsed.data.limit);

  return {
    items: items.map(toWorkflowRunResponse),
    nextCursor: matched.length > parsed.data.limit ? (items[items.length - 1]?.id ?? null) : null,
  };
}

/**
 * `POST /v1/workflows/{id}/test` — the dry run. **It writes nothing**: no run
 * row, no ticket write, no notification. A supervisor testing a workflow that
 * closes tickets must not close one, and there is no way to un-close it.
 */
function testWorkflow({ principal, params, body }: RouteContext): WorkflowTestResponse {
  const workflow = findWorkflowInTenant(principal, params[0]);
  const parsed = WorkflowTestInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const ticket = findTicketInTenant(principal, parsed.data.ticketId);
  const conditions = workflow.conditions.map((condition, index) => ({
    index,
    type: condition.type,
    ...evaluateWorkflowCondition(condition, ticket),
  }));
  const matched = conditions.every((condition) => condition.held);

  return {
    matched,
    conditions,
    actions: matched
      ? workflow.actions.map((action, index) => ({
          index,
          type: action.type,
          outcome: workflowActionOutcome(action, ticket),
          describes: describeWorkflowAction(principal, action),
        }))
      : [],
  };
}

/**
 * One condition against one ticket's facts.
 *
 * Two of the seven cannot be answered from the fixture set — no `ticket_tags`
 * table and no per-contact tags on a mock ticket — and a mock that quietly said
 * `true` for them would teach the console a behaviour the product does not have.
 * They answer `false` with the reason, which is also exactly what the real
 * evaluator does for a ticket with no contact: **every condition with no data to
 * read is false, and never throws** (ADR 0009).
 */
function evaluateWorkflowCondition(
  condition: WorkflowCondition,
  ticket: MockTicket,
): { held: boolean; reason: string | null } {
  switch (condition.type) {
    case 'ticket_status':
      return held(condition.values.includes(ticket.status) === (condition.operator === 'in'));

    case 'ticket_priority':
      return held(condition.values.includes(ticket.priority) === (condition.operator === 'in'));

    case 'ticket_assignment':
      return held(matchesAssignmentState(condition, ticket));

    case 'ticket_tag':
      return { held: false, reason: 'no_ticket_tags' };

    case 'contact_tag':
      return { held: false, reason: ticket.contactId === null ? 'no_contact' : 'no_contact_tags' };

    case 'ticket_age': {
      const minutes = minutesSince(ticket.createdAt);

      return held(
        condition.operator === 'gte' ? minutes >= condition.minutes : minutes <= condition.minutes,
      );
    }

    case 'business_hours':
      // Fail-false when the tenant configured none, whichever way `within` is
      // set — 0007's rule, carried unchanged.
      return { held: false, reason: 'business_hours_unconfigured' };
  }
}

function matchesAssignmentState(
  condition: Extract<WorkflowCondition, { type: 'ticket_assignment' }>,
  ticket: MockTicket,
): boolean {
  switch (condition.state) {
    case 'unassigned':
      return ticket.assignedUserId === null && ticket.assignedTeamId === null;

    case 'assigned_to_user':
      return (
        ticket.assignedUserId !== null &&
        (condition.userId === null || ticket.assignedUserId === condition.userId)
      );

    case 'assigned_to_team':
      return (
        ticket.assignedTeamId !== null &&
        (condition.teamId === null || ticket.assignedTeamId === condition.teamId)
      );
  }
}

/** `no_op` where the ticket already holds the value — "it ran and changed nothing". */
function workflowActionOutcome(
  action: WorkflowAction,
  ticket: MockTicket,
): 'applied' | 'no_op' | 'failed' | 'skipped' {
  if (action.type === 'set_status') {
    return action.status === ticket.status ? 'no_op' : 'applied';
  }

  if (action.type === 'set_priority') {
    return action.priority === ticket.priority ? 'no_op' : 'applied';
  }

  return 'applied';
}

/**
 * The resolved sentence the API returns in `describes`. English literals here
 * stand in for the API's own copy, not the console's — the console renders this
 * string verbatim rather than re-deriving it, so a name that changed since the
 * workflow was written reads correctly with no second lookup.
 */
function describeWorkflowAction(principal: SessionPrincipal, action: WorkflowAction): string {
  switch (action.type) {
    case 'add_ticket_tag':
      return `Tag the ticket "${referenceName(principal, 'tag', action.tagId) ?? 'a deleted tag'}"`;

    case 'reassign':
      return action.target.kind === 'team'
        ? `Reassign to team "${referenceName(principal, 'team', action.target.teamId) ?? 'a deleted team'}"`
        : `Reassign to "${referenceName(principal, 'user', action.target.userId) ?? 'a removed agent'}"`;

    case 'notify':
      if (action.audience === 'user') {
        return `Notify "${referenceName(principal, 'user', action.userId ?? '') ?? 'a removed agent'}"`;
      }

      if (action.audience === 'team') {
        return `Notify team "${referenceName(principal, 'team', action.teamId ?? '') ?? 'a deleted team'}"`;
      }

      return 'Notify the supervisors';

    case 'set_status':
      return `Set the status to ${action.status}`;

    case 'set_priority':
      return `Set the priority to ${action.priority}`;
  }
}

// --- Contacts (TAR-33) -----------------------------------------------------

function listContacts({ principal, query }: RouteContext): CursorPage<ContactResponse> {
  const parsed = ContactListQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const { q, tagId, limit } = parsed.data;
  const needle = q?.trim().toLowerCase();

  const matches = tenantContacts(principal)
    // The API's single `q`, matched against name, phone and email — the three
    // things somebody has in front of them when they go looking for a contact.
    .filter(
      (contact) =>
        needle === undefined ||
        contact.displayName.toLowerCase().includes(needle) ||
        contact.phone.toLowerCase().includes(needle) ||
        (contact.email ?? '').toLowerCase().includes(needle),
    )
    .filter((contact) => tagId === undefined || contact.tags.some((tag) => tag.id === tagId))
    // `id` descending, newest first — what the shipped API orders by
    // (`apps/api/src/contacts/contacts.service.ts`), not alphabetical. A mock
    // that sorted differently would show a reviewer a directory production does
    // not have.
    .sort((left, right) => right.id.localeCompare(left.id));

  // One past the page, so the mock can answer "is there another" the same way
  // the API does — and so a truncated directory is a state a test can reach.
  // Answering `nextCursor: null` unconditionally is why no test could have
  // caught the count this page was reporting as a total.
  const page = matches.slice(0, limit);
  const nextCursor = matches.length > limit ? (page.at(-1)?.id ?? null) : null;

  return { items: page.map(toContactResponse), nextCursor };
}

function getContact({ principal, params }: RouteContext): ContactResponse {
  return toContactResponse(findContactInTenant(principal, params[0]));
}

function updateContact({ principal, params, body }: RouteContext): ContactResponse {
  const contact = findContactInTenant(principal, params[0]);
  const parsed = ContactUpdateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { displayName, email, tagIds, customFields } = parsed.data;

  return toContactResponse(
    writeContact(principal, {
      ...contact,
      displayName: displayName ?? contact.displayName,
      email: email === undefined ? contact.email : email,
      tags: tagIds === undefined ? contact.tags : resolveTagsInTenant(principal, tagIds),
      customFields:
        customFields === undefined
          ? contact.customFields
          : mergeCustomFields(principal, contact, customFields),
      updatedAt: MOCK_UPDATED_AT,
    }),
  );
}

/**
 * 0002 amendment 10's merge, and the validation that goes with it.
 *
 * Keys present are set, an explicit `null` clears one, and keys absent are left
 * exactly as they were. A key naming no definition is `validation_failed` rather
 * than silently dropped, and every value is checked with the contract's own
 * `customFieldValueIssue` — the same function the console disables its save
 * with, so a request the UI let through is a bug in the UI and not a difference
 * of opinion between two copies of the rules.
 */
function mergeCustomFields(
  principal: SessionPrincipal,
  contact: MockContact,
  patch: Record<string, string | null>,
): Record<string, string> {
  const definitions = tenantCustomFieldDefinitions(principal);
  // Rebuilt rather than spread, so the result can be `Record<string, string>`:
  // a response carries only the keys the contact has a value for, and a `null`
  // in it would be the placeholder amendment 10 says never crosses the wire.
  const merged: Record<string, string> = Object.fromEntries(
    Object.entries(contact.customFields).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );

  for (const [key, value] of Object.entries(patch)) {
    const definition = definitions.find((candidate) => candidate.key === key);

    if (definition === undefined) {
      throw refused(
        'validation_failed',
        `No custom field is defined with the key ${key}.`,
        HTTP_UNPROCESSABLE,
      );
    }

    if (value === null) {
      // An explicit clear. `delete`, not `= null`: a response carries only the
      // keys the contact has a value for, never a null placeholder.
      delete merged[key];
      continue;
    }

    const issue = customFieldValueIssue(definition, value);

    if (issue !== null) {
      throw refused('validation_failed', `${definition.label}: ${issue}`, HTTP_UNPROCESSABLE);
    }

    merged[key] = value;
  }

  return merged;
}

/**
 * Writes the contact **and** the snapshot every conversation embeds of it, so
 * the inbox context panel cannot go on showing a tag the profile has removed.
 * The real API denormalises the same way; a mock that only wrote one of the two
 * would hide the staleness rather than reproduce it.
 */
function writeContact(principal: SessionPrincipal, contact: MockContact): MockContact {
  const state = mockState();

  state.contacts.set(contact.id, contact);

  const response = toContactResponse(contact);

  for (const conversation of tenantConversations(principal)) {
    if (conversation.contact.id === contact.id) {
      state.conversations.set(conversation.id, { ...conversation, contact: response });
    }
  }

  return contact;
}

/** Whole `Tag` records for the ids a write named, refusing any from another tenant. */
/**
 * Whole `Tag` records for the ids a write named.
 *
 * An id this tenant does not hold is `validation_failed`, matching
 * `translateTagFailure` in `apps/api/src/tags/tags.http.ts` — **not** the 404
 * this used to answer. The difference is user-visible rather than cosmetic:
 * `validation_failed` is in `ACTIONABLE_ERROR_CODES`, so the agent reads which
 * tag was rejected, while `not_found` falls back to the generic line.
 *
 * A tag belonging to *another* tenant lands here too, and answering
 * `validation_failed` for it enumerates nothing: the message names only the id
 * the caller already sent, and says it is not in their tenant — which is exactly
 * what a caller who invented the id learns anyway.
 */
function resolveTagsInTenant(principal: SessionPrincipal, tagIds: readonly string[]): Tag[] {
  const vocabulary = tenantTags(principal);
  const unknown = tagIds.filter((id) => !vocabulary.some((candidate) => candidate.id === id));

  if (unknown.length > 0) {
    throw refused(
      'validation_failed',
      `${unknown.join(', ')} is not in this tenant.`,
      HTTP_UNPROCESSABLE,
    );
  }

  return tagIds.map((id) => {
    const tag = vocabulary.find((candidate) => candidate.id === id);

    if (tag === undefined) {
      throw notFound();
    }

    return toTagResponse(tag);
  });
}

// --- Contact vocabulary (TAR-33's resources) -------------------------------

function listTags({ principal }: RouteContext): CursorPage<Tag> {
  const items = tenantTags(principal)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(toTagResponse);

  return { items, nextCursor: null };
}

function listCustomFieldDefinitions({
  principal,
}: RouteContext): CursorPage<CustomFieldDefinition> {
  // `position` ascending, `id` as the tie-break — 0002 amendment 10's ordering,
  // not alphabetical: the admin chose this order and the profile form renders it.
  const items = orderedCustomFieldDefinitions(principal).map(toCustomFieldDefinitionResponse);

  return { items, nextCursor: null };
}

function createCustomFieldDefinition({ principal, body }: RouteContext): CustomFieldDefinition {
  const parsed = CustomFieldDefinitionCreateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const existing = tenantCustomFieldDefinitions(principal);

  // Exceeding the cap is `conflict`, per amendment 10 — the bounded list is a
  // promise the server keeps by refusing here rather than by truncating a read.
  if (existing.length >= CUSTOM_FIELD_LIMITS.definitionsPerTenant) {
    throw refused(
      'conflict',
      `This workspace already has ${String(CUSTOM_FIELD_LIMITS.definitionsPerTenant)} custom fields.`,
      HTTP_CONFLICT,
    );
  }

  // `(tenant_id, key)` is unique, and the key is what every stored value is
  // filed under — so a duplicate is a conflict, not an overwrite.
  if (existing.some((definition) => definition.key === parsed.data.key)) {
    throw refused(
      'conflict',
      `A custom field with the key ${parsed.data.key} already exists.`,
      HTTP_CONFLICT,
    );
  }

  const created: MockCustomFieldDefinition = {
    tenantId: principal.tenantId,
    id: nextMockId(),
    key: parsed.data.key,
    label: parsed.data.label.trim(),
    type: parsed.data.type,
    options: [...parsed.data.options],
    // Server-side `max(position) + 1`, so two admins creating a field at the
    // same moment do not both land on `0`.
    position:
      existing.reduce((highest, definition) => Math.max(highest, definition.position), -1) + 1,
    createdAt: MOCK_CREATED_AT,
    updatedAt: MOCK_UPDATED_AT,
  };

  mockState().customFieldDefinitions.set(created.id, created);

  return toCustomFieldDefinitionResponse(created);
}

/**
 * `label` and `options` only. `key` and `type` are immutable — the schema is
 * what refuses a body carrying either, so nothing here has to check for them.
 */
function updateCustomFieldDefinition({
  principal,
  params,
  body,
}: RouteContext): CustomFieldDefinition {
  const definition = findCustomFieldDefinitionInTenant(principal, params[0]);
  const parsed = CustomFieldDefinitionUpdateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { label, options } = parsed.data;

  if (options !== undefined && options.length > 0 !== (definition.type === 'select')) {
    throw refused(
      'validation_failed',
      '`options` is required for `select` and forbidden otherwise.',
      HTTP_UNPROCESSABLE,
    );
  }

  const updated: MockCustomFieldDefinition = {
    ...definition,
    label: label?.trim() ?? definition.label,
    // Removing an option rewrites no contact: a stored value outside the current
    // list survives untouched until that field is next written.
    options: options === undefined ? definition.options : [...options],
    updatedAt: MOCK_UPDATED_AT,
  };

  mockState().customFieldDefinitions.set(updated.id, updated);

  return toCustomFieldDefinitionResponse(updated);
}

/**
 * Deletes the definition **and** strips its key from every contact in the
 * tenant, in what the real API does in one transaction.
 *
 * Leaving the values orphaned would be cheaper and is the trap amendment 10
 * names: keys are unique per tenant, so an admin who deletes a field and later
 * re-creates the same key would get every old value back, on a screen giving no
 * hint they were ever there.
 */
function deleteCustomFieldDefinition({ principal, params }: RouteContext): null {
  const definition = findCustomFieldDefinitionInTenant(principal, params[0]);

  // A rule whose condition can never match again is a silent failure, so the
  // delete is refused with `conflict` and the admin disables the rule first.
  const blocking = tenantRules(principal).filter((rule) =>
    rule.conditions.some(
      (condition) => condition.type === 'contact_attribute' && condition.key === definition.key,
    ),
  );

  if (blocking.length > 0) {
    throw refused(
      'conflict',
      `This field is used by the routing ${blocking.length === 1 ? 'rule' : 'rules'} ${blocking
        .map((rule) => rule.name)
        .join(', ')}. Remove the condition first.`,
      HTTP_CONFLICT,
    );
  }

  const state = mockState();

  state.customFieldDefinitions.delete(definition.id);

  for (const contact of tenantContacts(principal)) {
    if (!(definition.key in contact.customFields)) {
      continue;
    }

    const customFields = { ...contact.customFields };

    delete customFields[definition.key];

    writeContact(principal, { ...contact, customFields, updatedAt: MOCK_UPDATED_AT });
  }

  return null;
}

function orderedCustomFieldDefinitions(principal: SessionPrincipal): MockCustomFieldDefinition[] {
  // `position` ascending, `id` as the tie-break — 0002 amendment 10's ordering,
  // not alphabetical: the admin chose this order and the profile form renders it.
  return tenantCustomFieldDefinitions(principal).sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

function findCustomFieldDefinitionInTenant(
  principal: SessionPrincipal,
  id: string | undefined,
): MockCustomFieldDefinition {
  const definition = tenantCustomFieldDefinitions(principal).find(
    (candidate) => candidate.id === id,
  );

  if (definition === undefined) {
    throw notFound();
  }

  return definition;
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

// --- Onboarding checklist (TAR-407) ----------------------------------------

/**
 * `GET /v1/tenant/onboarding` — the caller's own checklist.
 *
 * Tenant-scoped by construction: the store is keyed by tenant and this is the
 * only lookup, so there is no id a caller could pass to read somebody else's.
 * A tenant the fixtures never seeded gets a fresh all-pending checklist rather
 * than a 404 — a workspace that exists always has one.
 */
function readOnboardingChecklist({ principal }: RouteContext): OnboardingChecklistResponse {
  return toOnboardingResponse(tenantOnboarding(principal.tenantId));
}

/**
 * `PATCH /v1/tenant/onboarding/steps/{stepId}` — skip a step, or put it back.
 *
 * The route pattern only matches the contract's own step ids, so an unknown one
 * is a 404 from the router rather than a validation error here.
 *
 * It refuses `skip` on a completed step for the reason the contract gives:
 * putting off something already done is not a state the checklist can be in, and
 * a transport that allowed it would let the console ship a control the real API
 * rejects.
 */
function updateOnboardingStep({
  principal,
  params,
  body,
}: RouteContext): OnboardingChecklistResponse {
  const parsed = OnboardingStepUpdateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const checklist = tenantOnboarding(principal.tenantId);
  const stepId = params[0] as OnboardingStepId;
  const step = checklist.steps.find((candidate) => candidate.id === stepId);

  if (step === undefined) {
    throw notFound();
  }

  if (parsed.data.intent === 'skip' && step.status === 'completed') {
    throw refused(
      'conflict',
      'That step is already done, so there is nothing to skip.',
      HTTP_CONFLICT,
    );
  }

  writeOnboardingStep(checklist, stepId, {
    ...step,
    ...(parsed.data.intent === 'skip'
      ? { status: 'skipped' as const, skippedAt: MOCK_UPDATED_AT }
      : { status: 'pending' as const, skippedAt: null }),
  });

  return toOnboardingResponse(checklist);
}

/**
 * Marks a step done because the tenant actually did the thing — called from the
 * handlers that perform it, never from a client request.
 *
 * This is the mock's half of the contract's one real decision: completion is
 * server-derived. A fixture layer where the console ticked its own boxes would
 * let a checklist ship that describes nothing about the workspace.
 *
 * Idempotent, and it does not resurrect a skipped step's `skippedAt` — doing the
 * thing supersedes having put it off.
 */
function completeOnboardingStep(tenantId: string, stepId: OnboardingStepId): void {
  const checklist = tenantOnboarding(tenantId);
  const step = checklist.steps.find((candidate) => candidate.id === stepId);

  if (step === undefined || step.status === 'completed') {
    return;
  }

  writeOnboardingStep(checklist, stepId, {
    ...step,
    status: 'completed',
    completedAt: MOCK_UPDATED_AT,
    skippedAt: null,
  });
}

function tenantOnboarding(tenantId: string): MockOnboardingChecklist {
  const state = mockState();
  const existing = state.onboarding.get(tenantId);

  if (existing !== undefined) {
    return existing;
  }

  const created: MockOnboardingChecklist = {
    tenantId,
    steps: ONBOARDING_STEP_IDS.map((id) => ({
      id,
      status: 'pending',
      completedAt: null,
      skippedAt: null,
    })),
    completedAt: null,
    updatedAt: MOCK_CREATED_AT,
  };

  state.onboarding.set(tenantId, created);

  return created;
}

/**
 * Replaces one step and re-derives the checklist's own `completedAt`.
 *
 * Re-derived rather than set once, because a reopened step un-finishes the
 * checklist: an admin who puts branding back on the list has outstanding setup
 * again, and a `completedAt` that survived would leave the console showing the
 * finished state over an unfinished list.
 */
function writeOnboardingStep(
  checklist: MockOnboardingChecklist,
  stepId: OnboardingStepId,
  next: MockOnboardingChecklist['steps'][number],
): void {
  checklist.steps = checklist.steps.map((step) => (step.id === stepId ? next : step));
  checklist.completedAt = checklist.steps.every((step) => step.status !== 'pending')
    ? MOCK_UPDATED_AT
    : null;
  checklist.updatedAt = MOCK_UPDATED_AT;
}

/** Copies the steps out, so a caller cannot mutate the store by editing what it read. */
function toOnboardingResponse(checklist: MockOnboardingChecklist): OnboardingChecklistResponse {
  return {
    tenantId: checklist.tenantId,
    steps: checklist.steps.map((step) => ({ ...step })),
    completedAt: checklist.completedAt,
    updatedAt: checklist.updatedAt,
  };
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
  principal,
  body,
}: RouteContext): ConnectedWhatsAppBusinessAccountResponse {
  const parsed = WhatsAppEmbeddedSignupInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  if (parsed.data.code === MOCK_EXPIRED_SIGNUP_CODE) {
    throw signupFailed('code_expired');
  }

  // The one piece of state this otherwise-stateless handler does keep: the
  // onboarding checklist's first step is done because a number was actually
  // connected. Recorded after the refusal above, so a failed run leaves it alone.
  completeOnboardingStep(principal.tenantId, 'connect_whatsapp');

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

// --- Tenant record, branding and domains (TAR-409, TAR-418) ----------------

/** Every domain read starts here, so no handler can iterate the map unscoped. */
function tenantDomains(principal: SessionPrincipal): MockTenantDomain[] {
  return [...mockState().tenantDomains.values()].filter(
    (domain) => domain.tenantId === principal.tenantId,
  );
}

/**
 * `GET /v1/tenant/public` — what an anonymous caller on this host may see, and
 * nothing else. No slug, no status, no domains, no trial date.
 */
function getPublicTenant({ principal }: RouteContext): TenantPublicResponse {
  const tenant = currentTenant(principal);

  return { id: tenant.id, name: tenant.name, branding: tenant.branding };
}

function getTenant({ principal }: RouteContext): TenantResponse {
  return asTenantResponse(principal, currentTenant(principal));
}

/**
 * `GET /v1/tenant` and its `PATCH` are reachable without `domain:write`, so the
 * domain rows they carry drop the DNS setup half — the challenge token and the
 * routing record — for a principal who could not read them on
 * `GET /v1/tenant/domains`.
 *
 * Mirrors `TenantDomainsService.listForCaller()`. Modelled here rather than
 * left to the real API because mock mode is where the console's own screens get
 * reviewed, and a shell that renders from fields the live API withholds would
 * pass review and break in production.
 */
function asTenantResponse(principal: SessionPrincipal, tenant: TenantResponse): TenantResponse {
  if (roleHasPermission(principal.role, 'domain:write')) {
    return tenant;
  }

  return {
    ...tenant,
    domains: tenant.domains.map((domain) => ({ ...domain, verification: null, routing: null })),
  };
}

/**
 * A partial update, and partial *within* branding too: the console's profile
 * form sends `branding: { supportEmail }` and must not clear the colours it
 * never showed, which is what a naive `{ ...tenant, ...parsed.data }` would do.
 */
function updateTenant({ principal, body }: RouteContext): TenantResponse {
  const parsed = TenantUpdateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const tenant = currentTenant(principal);
  const updated: TenantResponse = {
    ...tenant,
    name: parsed.data.name ?? tenant.name,
    branding: { ...tenant.branding, ...parsed.data.branding },
  };

  mockState().tenants.set(tenant.id, updated);

  return asTenantResponse(principal, updated);
}

/**
 * Usage is counted from this store rather than stored beside the plan, so a
 * reviewer who sends an invitation watches the seat meter move.
 *
 * The seat count is `users` that are `active`, plus invitations still pending —
 * ADR 0009's rule, and the reason it gives for it: counting only active users
 * would let an admin mint unlimited invitations and blow past the cap the moment
 * a mailout landed.
 *
 * `occupiesSeat` narrows the *active* half only. An invited user carries
 * `occupiesSeat: false` — they are not billable until they accept — and
 * filtering the pending half on it would count exactly nobody, which is the bug
 * this rule exists to prevent.
 */
function getTenantLifecycle({ principal }: RouteContext): TenantLifecycleResponse {
  const lifecycle = mockState().tenantLifecycles.get(principal.tenantId);

  if (lifecycle === undefined) {
    throw notFound();
  }

  const users = tenantUsers(principal);

  return {
    // Scoping column stripped before anything leaves the transport, exactly as
    // `stripTenant` does for every other record here.
    ...stripTenant(lifecycle),
    usage: {
      seatsUsed: users.filter((user) => user.status === 'active' && user.occupiesSeat).length,
      seatsPending: users.filter((user) => user.status === 'invited').length,
      conversationsThisPeriod: tenantConversations(principal).length,
    },
  };
}

/**
 * The tenant row, with `domains` recomposed from the live domain map rather than
 * read off the stored copy (TAR-418).
 *
 * That map is the mutable source of truth — domains are added, verified and
 * removed one at a time — so returning the seeded array would show a hostname as
 * still pending immediately after a reviewer verified it.
 */
function currentTenant(principal: SessionPrincipal): TenantResponse {
  const tenant = mockState().tenants.get(principal.tenantId);

  if (tenant === undefined) {
    throw notFound();
  }

  return { ...tenant, domains: tenantDomains(principal).map(stripTenant) };
}

/**
 * `PUT /v1/tenant/branding/{kind}` — multipart.
 *
 * The bytes are dropped: this transport has nowhere to put them and the console
 * never reads them back through JavaScript, only through an `<img src>` the
 * browser fetches. What it *does* model is everything the UI depends on — the
 * cache-busted path, the sniffed type, the size and the timestamp — so the
 * asset card, the rail and the favicon all render from a real shape.
 *
 * ⚠️ The consequence is visible in mock mode and is **not a bug in the upload**:
 * the image at that path 404s, so the preview shows a broken image. The alt text
 * and the fallback path are what a reviewer can check here; the bytes need the
 * real endpoint.
 */
function putBrandingAsset({ principal, params, body }: RouteContext): TenantBranding {
  const tenant = currentTenant(principal);
  const kind = BrandingAssetKindSchema.parse(params[0]);

  if (!(body instanceof FormData)) {
    throw validationFailed();
  }

  const file = body.get(BRANDING_UPLOAD_FIELD);

  if (!(file instanceof File)) {
    throw validationFailed();
  }

  const limits = BRANDING_ASSET_LIMITS[kind];

  // The same two refusals the API makes, so the console's inline error path is
  // exercised against a real rejection rather than only against its own
  // pre-check.
  if (!limits.mimeTypes.includes(file.type)) {
    throw refused('validation_failed', 'That file type is not supported.', HTTP_UNPROCESSABLE);
  }

  if (file.size > limits.maxBytes) {
    throw refused('validation_failed', 'That file is too large.', HTTP_UNPROCESSABLE);
  }

  const updatedAt = new Date(MOCK_UPDATED_AT);
  const branding: TenantBranding = {
    ...tenant.branding,
    [kind]: {
      path: brandingAssetPath(kind, updatedAt),
      mimeType: file.type,
      sizeBytes: file.size,
      updatedAt: updatedAt.toISOString(),
    },
  };

  mockState().tenants.set(tenant.id, { ...tenant, branding });

  return branding;
}

/** 204 either way: removing an asset that is already absent is not an error. */
function deleteBrandingAsset({ principal, params }: RouteContext): null {
  const tenant = currentTenant(principal);
  const kind = BrandingAssetKindSchema.parse(params[0]);

  mockState().tenants.set(tenant.id, {
    ...tenant,
    branding: { ...tenant.branding, [kind]: null },
  });

  return null;
}

function listTenantDomains({ principal }: RouteContext): TenantDomainListResponse {
  return { items: tenantDomains(principal).map(stripTenant) };
}

function createTenantDomain({ principal, body }: RouteContext): TenantDomain {
  const parsed = TenantDomainCreateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { hostname } = parsed.data;
  const state = mockState();
  const mine = tenantDomains(principal).find((domain) => domain.hostname === hostname);

  // Re-adding a hostname this tenant already holds is idempotent, not an error.
  if (mine !== undefined) {
    return stripTenant(mine);
  }

  // The global unique index, which lives *below* row-level security: the
  // insert fails without this tenant being able to read — or learn anything
  // about — the conflicting row. The message must not say who holds it.
  if ([...state.tenantDomains.values()].some((domain) => domain.hostname === hostname)) {
    throw refused('conflict', 'That hostname is already in use.', HTTP_CONFLICT);
  }

  if (
    tenantDomains(principal).filter((domain) => domain.kind === 'custom').length >=
    MAX_CUSTOM_DOMAINS_PER_TENANT
  ) {
    throw refused(
      'plan_limit_exceeded',
      `You can have up to ${MAX_CUSTOM_DOMAINS_PER_TENANT} custom domains.`,
      HTTP_UNPROCESSABLE,
    );
  }

  const created: MockTenantDomain = {
    tenantId: principal.tenantId,
    id: nextMockId(),
    hostname,
    kind: 'custom',
    status: 'pending_verification',
    isPrimary: false,
    verifiedAt: null,
    activatedAt: null,
    verification: {
      recordType: 'TXT',
      recordName: `_whatsappcrm-challenge.${hostname}`,
      recordValue: `whatsappcrm-domain-verification=${MOCK_VERIFICATION_TOKEN}`,
      lastCheckedAt: null,
      lastFailureReason: null,
      expiresAt: MOCK_CLAIM_EXPIRES_AT,
    },
    routing: {
      recordType: 'CNAME',
      recordName: hostname,
      recordValue: MOCK_EDGE_HOSTNAME,
    },
    createdAt: MOCK_CREATED_AT,
  };

  state.tenantDomains.set(created.id, created);

  return stripTenant(created);
}

/**
 * A hostname this transport never verifies, so the "we still cannot see the
 * record" branch can be walked repeatedly. Any other hostname verifies on the
 * next check — the seeded `support.northwind.example` starts pending with a
 * `record_not_found` reason, so both states are reachable without editing a file.
 */
export const MOCK_UNVERIFIABLE_HOSTNAME_PREFIX = 'unverifiable.';

/**
 * `POST /domains/{id}/verify`.
 *
 * A check that finds nothing answers **200 with the domain** and a failure
 * reason, not an error envelope: nothing went wrong with the request. Modelling
 * it as a refusal here would let the console ship a red error state for a
 * perfectly normal "DNS has not propagated yet".
 */
function verifyTenantDomain({ principal, params }: RouteContext): TenantDomain {
  const domain = findDomainInTenant(principal, params[0]);

  if (domain.kind === 'platform') {
    throw refused('forbidden', 'A platform subdomain needs no verification.');
  }

  const isVerifiable = !domain.hostname.startsWith(MOCK_UNVERIFIABLE_HOSTNAME_PREFIX);
  const verified: MockTenantDomain = isVerifiable
    ? {
        ...domain,
        status: 'verified',
        verifiedAt: MOCK_UPDATED_AT,
        verification:
          domain.verification === null
            ? null
            : { ...domain.verification, lastCheckedAt: MOCK_UPDATED_AT, lastFailureReason: null },
      }
    : {
        ...domain,
        verification:
          domain.verification === null
            ? null
            : {
                ...domain.verification,
                lastCheckedAt: MOCK_UPDATED_AT,
                lastFailureReason: 'record_not_found',
              },
      };

  mockState().tenantDomains.set(verified.id, verified);

  return stripTenant(verified);
}

/**
 * One transaction: clear the current primary, set the new one.
 *
 * Both refusals are the API's (`TenantDomainsService.setPrimary`): invite and
 * password-reset links are mailed to the primary, so it has to be a hostname the
 * tenant has proved *and* one the edge is actually serving. A custom domain
 * waits for an operator to attach it; a platform subdomain never does.
 */
function setPrimaryTenantDomain({ principal, params }: RouteContext): TenantDomain {
  const domain = findDomainInTenant(principal, params[0]);

  if (domain.verifiedAt === null) {
    throw refused('conflict', 'Verify this domain before making it primary.', HTTP_CONFLICT);
  }

  if (domain.kind === 'custom' && domain.activatedAt === null) {
    throw refused(
      'conflict',
      'This domain is verified but is not serving traffic yet. It can be the main address once ' +
        'its certificate has been issued.',
      HTTP_CONFLICT,
    );
  }

  const state = mockState();

  for (const candidate of tenantDomains(principal)) {
    if (candidate.isPrimary && candidate.id !== domain.id) {
      state.tenantDomains.set(candidate.id, { ...candidate, isPrimary: false });
    }
  }

  const promoted: MockTenantDomain = { ...domain, isPrimary: true };

  state.tenantDomains.set(promoted.id, promoted);

  return stripTenant(promoted);
}

/**
 * `DELETE /v1/tenant/domains/{id}`.
 *
 * The platform subdomain is refused outright: it is how a tenant always reaches
 * the console, and one that deleted its last domain would be unreachable and
 * unrecoverable without an operator. Deleting the current primary moves primary
 * back to that subdomain in the same transaction, so the tenant is never left
 * with none.
 */
function deleteTenantDomain({ principal, params }: RouteContext): null {
  const domain = findDomainInTenant(principal, params[0]);

  if (domain.kind === 'platform') {
    throw refused('forbidden', 'Your platform subdomain cannot be removed.');
  }

  const state = mockState();

  state.tenantDomains.delete(domain.id);

  if (domain.isPrimary) {
    const platform = tenantDomains(principal).find((candidate) => candidate.kind === 'platform');

    if (platform !== undefined) {
      state.tenantDomains.set(platform.id, { ...platform, isPrimary: true });
    }
  }

  return null;
}

function findDomainInTenant(principal: SessionPrincipal, id: string | undefined): MockTenantDomain {
  const domain = tenantDomains(principal).find((candidate) => candidate.id === id);

  if (domain === undefined) {
    throw notFound();
  }

  return domain;
}

/** Literals, for the reason every other fixture value is one: hydration. */
const MOCK_VERIFICATION_TOKEN = '3b91c07de42a4d5b8e1f6c2a0d7e9341';
const MOCK_CLAIM_EXPIRES_AT = '2026-08-28T09:00:00.000Z';
const MOCK_EDGE_HOSTNAME = 'whatsappcrm-web.onrender.example';
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
 * `POST /v1/tickets/{id}/assign` — the manual placement TAR-274 offers, and the
 * reassignment TAR-32 adds on top of it (ADR 0011 decision 1).
 *
 * Two writes, not one, and the second is the point: naming an assignee also moves
 * `routing.state` to `manual` and clears the deferred columns, which is what stops
 * a later routing pass overruling the supervisor. Modelled here rather than
 * assumed, because the row vanishing from the flagged queue afterwards is exactly
 * the behaviour that view is claiming.
 *
 * The ordering below is the contract's, and it is fixed: `require` (visibility,
 * done by `findTicketInTenant`) → handoff bound → reason rule → assignee
 * existence → the no-op check → the write. The reason rule runs **before** the
 * assignee lookup so a caller missing a reason is told that, rather than being
 * sent to check a user id that was fine.
 */
function assignTicket({ principal, params, body }: RouteContext): TicketResponse {
  const ticket = findTicketInTenant(principal, params[0]);
  const parsed = TicketAssignInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { userId, teamId, reason } = parsed.data;
  const after = {
    assignedUserId: userId === undefined ? ticket.assignedUserId : userId,
    assignedTeamId: teamId === undefined ? ticket.assignedTeamId : teamId,
  };

  assertTicketHandoffAllowed(principal, ticket, after);

  // The conditional half of decision 1, raised here rather than by the schema:
  // Zod sees the body and the rule is about the row. It is checked even when the
  // request moves nothing — silently accepting a reasonless no-op would train a
  // console to omit the field.
  if (reason === undefined && ticketAssignRequiresReason(ticket)) {
    throw refused(
      'validation_failed',
      'A reason is required when reassigning a ticket somebody already holds.',
      HTTP_UNPROCESSABLE,
    );
  }

  if (typeof userId === 'string') {
    const user = findUserInTenant(principal, userId);

    if (user.status !== 'active') {
      throw refused('validation_failed', 'That user cannot take tickets.', HTTP_UNPROCESSABLE);
    }
  }

  if (typeof teamId === 'string') {
    findTeamInTenant(principal, teamId);
  }

  const movesAnything =
    after.assignedUserId !== ticket.assignedUserId ||
    after.assignedTeamId !== ticket.assignedTeamId;

  if (!movesAnything) {
    return toTicketResponse(ticket);
  }

  const assigned: MockTicket = {
    ...ticket,
    ...after,
    routing: { state: 'manual', deferredReason: null, deferredSince: null },
  };

  mockState().tickets.set(assigned.id, assigned);
  // `assigned` when somebody still holds it, `unassigned` when the write
  // released it — the pair TAR-32 reuses rather than adding a third type meaning
  // "the assignment moved".
  appendTicketEvent(principal, {
    ticketId: assigned.id,
    type:
      after.assignedUserId === null && after.assignedTeamId === null ? 'unassigned' : 'assigned',
    actorUserId: principal.userId,
    cause: 'agent',
    assignment: {
      fromUserId: ticket.assignedUserId,
      fromTeamId: ticket.assignedTeamId,
      toUserId: after.assignedUserId,
      toTeamId: after.assignedTeamId,
    },
    reason: reason ?? null,
  });

  return toTicketResponse(assigned);
}

/**
 * The bound ADR 0011 decision 2 puts on `ticket:handoff`, so the console's
 * refusals are exercised against a real 403 rather than only described.
 *
 * A caller holding `ticket:assign` skips all of it — their write is what TAR-23
 * shipped. A caller who does not may write only when all three hold:
 *
 *   1. **They hold the ticket.** Not "their team holds it": a ticket routed to a
 *      team is nobody's to give away, and every member could otherwise reassign
 *      it out from under whoever is working it.
 *   2. **The target is a teammate**, sharing at least one team with the caller —
 *      or one of the caller's own teams.
 *   3. **They are not releasing it.** Dropping a ticket back to unassigned is
 *      abandonment, and puts it in a state only `ticket:assign` can create.
 *
 * `forbidden`, not `not_found`: the caller has already passed the visibility
 * rule and is looking at the ticket, so what is refused is the act.
 */
function assertTicketHandoffAllowed(
  principal: SessionPrincipal,
  before: MockTicket,
  after: { assignedUserId: string | null; assignedTeamId: string | null },
): void {
  if (roleHasPermission(principal.role, 'ticket:assign')) {
    return;
  }

  if (before.assignedUserId !== principal.userId) {
    throw refused('forbidden', 'You can only hand on a ticket you are holding.');
  }

  if (after.assignedUserId === null && after.assignedTeamId === null) {
    throw refused('forbidden', 'Releasing a ticket needs ticket:assign. Hand it to somebody.');
  }

  if (after.assignedUserId !== null && after.assignedUserId !== principal.userId) {
    const target = findUserInTenant(principal, after.assignedUserId);
    const sharesATeam = target.teamIds.some((teamId) => principal.teamIds.includes(teamId));

    if (!sharesATeam) {
      throw refused('forbidden', 'You can only hand a ticket to a teammate.');
    }
  }

  if (after.assignedTeamId !== null && !principal.teamIds.includes(after.assignedTeamId)) {
    throw refused('forbidden', 'You can only hand a ticket to one of your own teams.');
  }
}

/**
 * `POST /v1/tickets/{id}/escalate` — raise attention without moving the
 * assignment (ADR 0011 decision 3).
 *
 * The three things the console is built around, all reachable here:
 *
 *   * a **named** supervisor, who must exist in this tenant, be active, and hold
 *     `ticket:read_all` — anything else is `validation_failed` on `toUserId`,
 *     which is what makes the notification safe to send at all;
 *   * an **unnamed** escalation, whose recipients are derived the way ADR 0006
 *     derives them for a breach — supervisors and admins sharing a team with the
 *     holder, falling back to every candidate;
 *   * **nobody at all.** A tenant with no active supervisor still gets the event
 *     written and an empty `notifiedUserIds`. Not an error: the agent did
 *     nothing wrong and has no way to fix it.
 *
 * The ticket itself is never touched, and that is asserted by omission here.
 */
function escalateTicket({ principal, params, body }: RouteContext): TicketEscalationResponse {
  const ticket = findTicketInTenant(principal, params[0]);
  const parsed = TicketEscalateInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { reason, toUserId } = parsed.data;
  const recipients = escalationRecipients(principal, ticket, toUserId);

  const event = appendTicketEvent(principal, {
    ticketId: ticket.id,
    type: 'escalated',
    actorUserId: principal.userId,
    cause: 'agent',
    // Null when the escalation was addressed to whoever supervises this ticket
    // rather than to a person. Meaningful, not missing.
    toValue: toUserId ?? null,
    reason,
  });

  return { event, notifiedUserIds: recipients.map((user) => user.id) };
}

/**
 * Who an escalation is delivered to, mirroring `resolveAlertRecipients`
 * (ADR 0006 decision 4) rather than inventing a second rule.
 *
 * Candidates are active users holding `ticket:read_all` — the population that
 * can already read the ticket, which is what makes telling them about it
 * disclose nothing new. They are narrowed to those sharing a team with whoever
 * holds the ticket, and the narrowing falls back to every candidate when it
 * yields nobody: an unstaffed team must not swallow the escalation.
 */
function escalationRecipients(
  principal: SessionPrincipal,
  ticket: MockTicket,
  toUserId: string | undefined,
): MockUser[] {
  const candidates = tenantUsers(principal).filter(
    (user) => user.status === 'active' && roleHasPermission(user.role, 'ticket:read_all'),
  );

  if (toUserId !== undefined) {
    const named = candidates.find((user) => user.id === toUserId);

    if (named === undefined) {
      // `validation_failed` on the field, mirroring an unknown assignee — never
      // a 404, which would confirm the id names somebody real elsewhere.
      throw refused(
        'validation_failed',
        'That person cannot receive an escalation for this ticket.',
        HTTP_UNPROCESSABLE,
      );
    }

    return [named];
  }

  const holderTeamIds =
    ticket.assignedTeamId === null
      ? (tenantUsers(principal).find((user) => user.id === ticket.assignedUserId)?.teamIds ?? [])
      : [ticket.assignedTeamId];

  const shared = candidates.filter((user) =>
    user.teamIds.some((teamId) => holderTeamIds.includes(teamId)),
  );

  return shared.length > 0 ? shared : candidates;
}

/**
 * `GET /v1/tickets/{id}/events` — newest first, which is the keyset order the
 * index in ADR 0011 serves.
 *
 * The ticket is resolved through `findTicketInTenant` first, so a ticket outside
 * this reader's scope answers `not_found` here exactly as it does on the GET.
 */
function listTicketEvents({ principal, params, query }: RouteContext): CursorPage<TicketEvent> {
  const ticket = findTicketInTenant(principal, params[0]);
  const parsed = TicketEventListQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const { limit } = parsed.data;
  const matched = tenantTicketEvents(principal)
    .filter((event) => event.ticketId === ticket.id)
    // `created_at DESC, id DESC`. The id tie-break is not decoration: the API
    // pages this on a keyset, and two events written in the same millisecond
    // would otherwise straddle a page boundary and lose one.
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );

  const items = matched.slice(0, limit);
  const nextCursor = matched.length > limit ? (items[items.length - 1]?.id ?? null) : null;

  return { items: items.map(toTicketEventResponse), nextCursor };
}

/**
 * Writes one row onto the ticket's trail and returns it as the wire shape.
 *
 * Every field the caller does not name defaults to null, so a new event type
 * cannot accidentally inherit another's `fromValue` — and both of TAR-32's
 * events are always attributed, because neither route is reachable without a
 * principal and an event claiming a system actor on a human decision would be a
 * lie the trail cannot recover from.
 */
function appendTicketEvent(
  principal: SessionPrincipal,
  event: Pick<MockTicketEvent, 'ticketId' | 'type'> & Partial<MockTicketEvent>,
): TicketEvent {
  const created: MockTicketEvent = {
    tenantId: principal.tenantId,
    id: nextMockId(),
    actorUserId: null,
    fromValue: null,
    toValue: null,
    assignment: null,
    reason: null,
    cause: null,
    createdAt: new Date().toISOString(),
    ...event,
  };

  mockState().ticketEvents.set(created.id, created);

  return toTicketEventResponse(created);
}

function tenantTicketEvents(principal: SessionPrincipal): MockTicketEvent[] {
  return [...mockState().ticketEvents.values()].filter(
    (event) => event.tenantId === principal.tenantId,
  );
}

function toTicketEventResponse(event: MockTicketEvent): TicketEvent {
  return stripTenant(event);
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

// --- Reporting (TAR-30, ADR 0009) ------------------------------------------

/**
 * `GET /v1/reports/dashboard` — the four metrics over a date range.
 *
 * Validated against the contract's own query schema rather than read key by key,
 * because two of its rules are refusals the console has to render: `from` after
 * `to`, and a range over `REPORT_RANGE_MAX_DAYS`. Both answer `validation_failed`
 * before any aggregation runs, exactly as the real route does.
 *
 * The aggregation itself lives in `mock/reporting.ts` — it is the one handler
 * whose body is arithmetic rather than a filter, and inlining it here would bury
 * the four rules it mirrors.
 */
function reportDashboard({ principal, query }: RouteContext): DashboardMetricsResponse {
  const parsed = DashboardMetricsQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  return dashboardMetrics({
    principal,
    query: parsed.data,
    tickets: tenantTickets(principal),
    users: tenantUsers(principal),
  });
}

/**
 * `GET /v1/reports/dashboard/export` — the same numbers, as CSV (TAR-431).
 *
 * **It calls `dashboardMetrics` and serialises what comes back.** There is no
 * second aggregation here and there must never be one: that is ADR 0009
 * decision 1 reproduced in the fixture layer, so the mock export cannot drift
 * from the mock dashboard any more than the real one can from the real dashboard.
 * `section` selects a code path in the serialiser and touches nothing about the
 * figures.
 *
 * It answers a string rather than an object, which is what the real route does
 * with bytes. `handleMockRequest`'s callers treat the body as opaque, so nothing
 * downstream has to know which of the two it got.
 */
function reportDashboardExport({ principal, query }: RouteContext): string {
  const parsed = DashboardExportQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const { section, ...metricsQuery } = parsed.data;

  return dashboardCsv(
    dashboardMetrics({
      principal,
      query: metricsQuery,
      tickets: tenantTickets(principal),
      users: tenantUsers(principal),
    }),
    section,
  );
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
    // An agent typed this one, which is what `origin` records (TAR-28, 0010
    // decision 14). The database's own CHECK ties it to `direction`, so an
    // outbound message may be anything except `contact`.
    origin: 'agent',
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

// --- The AI chatbot (TAR-28) -----------------------------------------------
//
// Two rules from ADR 0010 are enforced here rather than assumed, because the
// console's whole empty-state story rests on them:
//
//   1. **Readiness is derived, never stored.** `aiReadiness` recomputes the four
//      clauses from the plan and the documents in this store on every read, so a
//      knowledge base emptied in the UI reports `no_indexed_documents` on the
//      next render instead of a stale `ready: true`.
//   2. **Indexing is asynchronous.** A create, and a `PATCH` that touches
//      `content`, come back `pending` with `chunkCount: 0`. Nothing here ever
//      moves a document to `indexed` by itself — the reindex route is the only
//      way forward, which is what makes the pending and failed states reachable
//      in mock mode rather than theoretical.

function listKnowledgeDocuments({
  principal,
  query,
}: RouteContext): CursorPage<KnowledgeDocumentListItem> {
  const parsed = KnowledgeDocumentListQuerySchema.safeParse(Object.fromEntries(query));

  if (!parsed.success) {
    throw validationFailed();
  }

  const { status, q, limit } = parsed.data;
  const needle = q?.trim().toLowerCase();

  const items = tenantKnowledgeDocuments(principal)
    .filter((document) => status === undefined || document.status === status)
    .filter((document) => needle === undefined || document.title.toLowerCase().includes(needle))
    .sort(byNewestFirst)
    .slice(0, limit)
    // `content` is omitted from list items, exactly as the endpoint does: a page
    // of documents each holding up to 256 KiB is a response nobody wants. Absent
    // rather than blanked — an empty string reads as "this entry has no text",
    // and the editor that prefilled from it would save that emptiness back.
    .map(toKnowledgeDocumentListItem);

  return { items, nextCursor: null };
}

function getKnowledgeDocument({ principal, params }: RouteContext): KnowledgeDocumentResponse {
  return toKnowledgeDocumentResponse(findKnowledgeDocumentInTenant(principal, params[0]));
}

function createKnowledgeDocument({ principal, body }: RouteContext): KnowledgeDocumentResponse {
  assertAiFeature(principal);

  const parsed = CreateKnowledgeDocumentInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  if (tenantKnowledgeDocuments(principal).length >= KNOWLEDGE_DOCUMENT_LIMITS.documentsPerTenant) {
    throw refused(
      'conflict',
      `This workspace already holds the maximum of ${KNOWLEDGE_DOCUMENT_LIMITS.documentsPerTenant} knowledge base entries.`,
      HTTP_CONFLICT,
    );
  }

  const created: MockKnowledgeDocument = {
    tenantId: principal.tenantId,
    id: nextMockId(),
    title: parsed.data.title,
    content: parsed.data.content,
    sourceUrl: parsed.data.sourceUrl ?? null,
    language: parsed.data.language ?? null,
    status: 'pending',
    chunkCount: 0,
    indexError: null,
    indexedAt: null,
    createdAt: MOCK_CREATED_AT,
    updatedAt: MOCK_CREATED_AT,
  };

  mockState().knowledgeDocuments.set(created.id, created);

  return toKnowledgeDocumentResponse(created);
}

function updateKnowledgeDocument({
  principal,
  params,
  body,
}: RouteContext): KnowledgeDocumentResponse {
  assertAiFeature(principal);

  const document = findKnowledgeDocumentInTenant(principal, params[0]);
  const parsed = UpdateKnowledgeDocumentInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const { title, content, sourceUrl, language } = parsed.data;
  // Only a *content* change invalidates the chunks. Renaming a document or
  // correcting its source URL leaves what the bot retrieves untouched, and
  // re-queueing an index for it would take a working document out of service
  // for no reason.
  const isReindexed = content !== undefined && content !== document.content;

  const updated: MockKnowledgeDocument = {
    ...document,
    title: title ?? document.title,
    content: content ?? document.content,
    sourceUrl: sourceUrl ?? document.sourceUrl,
    language: language ?? document.language,
    status: isReindexed ? 'pending' : document.status,
    chunkCount: isReindexed ? 0 : document.chunkCount,
    indexError: isReindexed ? null : document.indexError,
    indexedAt: isReindexed ? null : document.indexedAt,
    updatedAt: MOCK_UPDATED_AT,
  };

  mockState().knowledgeDocuments.set(updated.id, updated);

  return toKnowledgeDocumentResponse(updated);
}

function deleteKnowledgeDocument({ principal, params }: RouteContext): null {
  assertAiFeature(principal);

  const document = findKnowledgeDocumentInTenant(principal, params[0]);

  mockState().knowledgeDocuments.delete(document.id);

  return null;
}

/**
 * The one recovery path for a document whose indexing failed, and the only way
 * a `pending` document reaches `indexed` here.
 *
 * The real endpoint answers `202` and the worker does the chunking; this
 * completes it inline, because a mock that left every document pending forever
 * would make the ready state unreachable. The chunk count is derived from the
 * paragraph count, which is how the real indexer splits.
 */
function reindexKnowledgeDocument({ principal, params }: RouteContext): KnowledgeDocumentResponse {
  assertAiFeature(principal);

  const document = findKnowledgeDocumentInTenant(principal, params[0]);
  const chunkCount = countChunks(document.content);

  const reindexed: MockKnowledgeDocument =
    chunkCount === 0
      ? {
          ...document,
          status: 'failed',
          chunkCount: 0,
          indexError: 'The document produced no usable text to index.',
          indexedAt: null,
          updatedAt: MOCK_UPDATED_AT,
        }
      : {
          ...document,
          status: 'indexed',
          chunkCount,
          indexError: null,
          indexedAt: MOCK_UPDATED_AT,
          updatedAt: MOCK_UPDATED_AT,
        };

  mockState().knowledgeDocuments.set(reindexed.id, reindexed);

  return toKnowledgeDocumentResponse(reindexed);
}

function getAiConfig({ principal }: RouteContext): AiConfigResponse {
  return toAiConfigResponse(principal, currentAiConfig(principal));
}

function updateAiConfig({ principal, body }: RouteContext): AiConfigResponse {
  assertAiFeature(principal);

  const parsed = UpdateAiConfigInputSchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed();
  }

  const current = currentAiConfig(principal);
  const updated: MockAiConfigRecord = {
    ...current,
    ...parsed.data,
    handoffKeywords: parsed.data.handoffKeywords ?? current.handoffKeywords,
    updatedAt: MOCK_UPDATED_AT,
  };

  mockState().aiConfigs.set(principal.tenantId, updated);

  return toAiConfigResponse(principal, updated);
}

/**
 * The handoff summary for one conversation, or `404`.
 *
 * `404` covers three different facts on purpose — no such conversation, one this
 * principal may not see, and one that has never handed off — because the
 * alternative leaks which conversations exist. `botExchange` is rebuilt from the
 * thread rather than stored, so it cannot disagree with the messages rendered
 * beside it.
 */
function getHandoffContext({ principal, params }: RouteContext): HandoffContextResponse {
  const conversation = findConversationInTenant(principal, params[0]);
  const handoff = tenantHandoffs(principal)
    .filter((candidate) => candidate.conversationId === conversation.id)
    .sort((left, right) => right.handedOffAt.localeCompare(left.handedOffAt))[0];

  if (handoff === undefined) {
    throw notFound();
  }

  // `botEngagedAt` is null when the chatbot never reached the model — a
  // `no_match`, or a gate-level refusal before any reply — and there is no
  // exchange to rebuild in that case rather than one starting at the epoch.
  const engagedAt = handoff.botEngagedAt;
  const botExchange = tenantMessages(principal)
    .filter(
      (message) =>
        engagedAt !== null &&
        message.conversationId === conversation.id &&
        message.sentAt >= engagedAt &&
        message.id !== handoff.triggerMessageId,
    )
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt))
    .map(toMessageResponse);

  return {
    conversationId: handoff.conversationId,
    ticketId: handoff.ticketId,
    reason: handoff.reason,
    triggerMessageId: handoff.triggerMessageId,
    triggerMessageBody: handoff.triggerMessageBody,
    botExchange,
    botEngagedAt: handoff.botEngagedAt,
    handedOffAt: handoff.handedOffAt,
    botReplyCount: handoff.botReplyCount,
    confidence: handoff.confidence,
    citedDocuments: handoff.citedDocuments,
  };
}

/**
 * An agent taking a bot-active thread from the console.
 *
 * Idempotent, and that is the whole design: a conversation already `handed_off`
 * or `human_active` answers `200` with the current record and writes nothing, so
 * a double-click is a no-op rather than a `409`.
 */
function requestHandoff({ principal, params, body }: RouteContext): ConversationResponse {
  const conversation = findConversationInTenant(principal, params[0]);
  const parsed = RequestHandoffInputSchema.safeParse(body ?? {});

  if (!parsed.success) {
    throw validationFailed();
  }

  // Idempotent: only a thread the chatbot still holds has anything to release.
  // Anything else answers 200 with the current record and writes nothing, so a
  // double press is a no-op rather than a `409`.
  if (conversation.botState !== 'bot_active') {
    return toConversationResponse(conversation);
  }

  const handedOff: MockConversation = {
    ...conversation,
    botHandling: false,
    botState: 'handed_off',
    updatedAt: MOCK_UPDATED_AT,
  };

  mockState().conversations.set(handedOff.id, handedOff);

  const trigger = tenantMessages(principal)
    .filter((message) => message.conversationId === conversation.id)
    .sort((left, right) => right.sentAt.localeCompare(left.sentAt))[0];

  if (trigger !== undefined) {
    const id = nextMockId();

    mockState().handoffs.set(id, {
      tenantId: principal.tenantId,
      id,
      conversationId: conversation.id,
      ticketId: conversation.ticketId,
      reason: 'agent_requested',
      triggerMessageId: trigger.id,
      triggerMessageBody: trigger.body,
      botEngagedAt: trigger.sentAt,
      handedOffAt: MOCK_UPDATED_AT,
      // The agent stepped in; whatever the bot had said before is already in the
      // thread, and this transport does not run turns to count them.
      botReplyCount: 0,
      confidence: null,
      citedDocuments: [],
    });
  }

  return toConversationResponse(handedOff);
}

/** The tenant's configuration, or the seeded defaults it reads before its first write. */
function currentAiConfig(principal: SessionPrincipal): MockAiConfigRecord {
  return (
    mockState().aiConfigs.get(principal.tenantId) ?? {
      tenantId: principal.tenantId,
      isEnabled: AI_CONFIG_DEFAULTS.isEnabled,
      model: null,
      systemPrompt: null,
      handoffKeywords: [],
      minConfidence: AI_CONFIG_DEFAULTS.minConfidence,
      maxBotTurns: AI_CONFIG_DEFAULTS.maxBotTurns,
      handoffMessage: null,
      updatedAt: MOCK_CREATED_AT,
    }
  );
}

function toAiConfigResponse(
  principal: SessionPrincipal,
  config: MockAiConfigRecord,
): AiConfigResponse {
  return {
    ...stripTenant(config),
    readiness: aiReadiness(principal, config),
    availableModels: [...AI_MODEL_CATALOG],
  };
}

/**
 * The four clauses of ADR 0010's KB-ready rule, every failing one reported.
 *
 * All four rather than the first: an admin who fixes one of four and still gets
 * silence has learned nothing, and this array is what lets the console say what
 * is left.
 *
 * `provider_not_configured` never fires here — a fixture layer has no
 * `ANTHROPIC_API_KEY` to be missing — and that is stated rather than silently
 * omitted, because it is the one blocker a tenant cannot clear themselves.
 */
function aiReadiness(principal: SessionPrincipal, config: MockAiConfigRecord): AiReadiness {
  const indexedDocumentCount = tenantKnowledgeDocuments(principal).filter(
    (document) => document.status === 'indexed' && document.chunkCount > 0,
  ).length;

  const blockers: AiReadinessBlocker[] = [];

  if (!hasAiFeature(principal)) {
    blockers.push('feature_not_in_plan');
  }

  if (!config.isEnabled) {
    blockers.push('disabled');
  }

  if (indexedDocumentCount === 0) {
    blockers.push('no_indexed_documents');
  }

  return { ready: blockers.length === 0, indexedDocumentCount, blockers };
}

function hasAiFeature(principal: SessionPrincipal): boolean {
  return (
    mockState()
      .tenantLifecycles.get(principal.tenantId)
      ?.plan.entitlements.features.includes('ai_chatbot') ?? false
  );
}

function assertAiFeature(principal: SessionPrincipal): void {
  if (!hasAiFeature(principal)) {
    throw refused(
      'feature_not_in_plan',
      'The AI chatbot is not included in this workspace’s plan.',
    );
  }
}

/** Paragraph-packed chunking, as ADR 0010 describes it: blank lines are the boundary. */
function countChunks(content: string): number {
  return content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0).length;
}

function byNewestFirst(left: MockKnowledgeDocument, right: MockKnowledgeDocument): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
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

function tenantContacts(principal: SessionPrincipal): MockContact[] {
  return [...mockState().contacts.values()].filter(
    (contact) => contact.tenantId === principal.tenantId,
  );
}

/**
 * A record in another tenant answers 404, never 403 — the two are
 * indistinguishable by design so nothing can be enumerated across tenants.
 */
function findContactInTenant(principal: SessionPrincipal, id: string | undefined): MockContact {
  const contact = tenantContacts(principal).find((candidate) => candidate.id === id);

  if (contact === undefined) {
    throw notFound();
  }

  return contact;
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

function tenantKnowledgeDocuments(principal: SessionPrincipal): MockKnowledgeDocument[] {
  return [...mockState().knowledgeDocuments.values()].filter(
    (document) => document.tenantId === principal.tenantId,
  );
}

function tenantHandoffs(principal: SessionPrincipal): MockHandoffRecord[] {
  return [...mockState().handoffs.values()].filter(
    (handoff) => handoff.tenantId === principal.tenantId,
  );
}

function findKnowledgeDocumentInTenant(
  principal: SessionPrincipal,
  id: string | undefined,
): MockKnowledgeDocument {
  const document = tenantKnowledgeDocuments(principal).find((candidate) => candidate.id === id);

  if (document === undefined) {
    throw notFound();
  }

  return document;
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

// --- Workflow helpers (ADR 0009) -------------------------------------------

function tenantWorkflows(principal: SessionPrincipal): MockWorkflow[] {
  return [...mockState().workflows.values()].filter(
    (workflow) => workflow.tenantId === principal.tenantId,
  );
}

function tenantWorkflowRuns(principal: SessionPrincipal): MockWorkflowRun[] {
  return [...mockState().workflowRuns.values()].filter(
    (run) => run.tenantId === principal.tenantId,
  );
}

function findWorkflowInTenant(principal: SessionPrincipal, id: string | undefined): MockWorkflow {
  const workflow = tenantWorkflows(principal).find((candidate) => candidate.id === id);

  if (workflow === undefined) {
    throw notFound();
  }

  return workflow;
}

function orderedTenantWorkflows(principal: SessionPrincipal): MockWorkflow[] {
  return tenantWorkflows(principal).sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

function nextWorkflowPosition(existing: readonly MockWorkflow[]): number {
  return existing.reduce((highest, workflow) => Math.max(highest, workflow.position + 1), 0);
}

/** Keeps `position` dense after a move, so the next move is never a no-op. */
function renumberTenantWorkflows(principal: SessionPrincipal): void {
  const state = mockState();

  orderedTenantWorkflows(principal).forEach((workflow, index) => {
    state.workflows.set(workflow.id, { ...workflow, position: index });
  });
}

/** `UNIQUE (tenant_id, name)` on a citext column, so the comparison folds case. */
function assertWorkflowNameFree(
  existing: readonly MockWorkflow[],
  name: string,
  ownWorkflowId: string | null,
): void {
  const candidate = name.trim().toLowerCase();
  const taken = existing.some(
    (workflow) => workflow.id !== ownWorkflowId && workflow.name.toLowerCase() === candidate,
  );

  if (taken) {
    throw refused('conflict', 'A workflow with that name already exists.', HTTP_CONFLICT);
  }
}

function workflowLimitReached(): ApiRequestError {
  return refused(
    'conflict',
    `A workspace can hold ${String(WORKFLOW_LIMITS.workflowsPerTenant)} workflows.`,
    HTTP_CONFLICT,
  );
}

/**
 * The second cap, and it is lower for a reason worth keeping visible: each
 * elapsed-trigger workflow is a threshold the sweep has to consider on every
 * tick, unlike an event trigger which costs nothing until it fires.
 */
function assertElapsedTriggerRoom(
  existing: readonly MockWorkflow[],
  trigger: MockWorkflow['trigger'],
  ownWorkflowId: string | null,
): void {
  if (trigger.type !== 'ticket_unresolved_for') {
    return;
  }

  const others = existing.filter(
    (workflow) =>
      workflow.id !== ownWorkflowId && workflow.trigger.type === 'ticket_unresolved_for',
  );

  if (others.length >= WORKFLOW_LIMITS.elapsedTriggerWorkflowsPerTenant) {
    throw refused(
      'conflict',
      `A workspace can hold ${String(WORKFLOW_LIMITS.elapsedTriggerWorkflowsPerTenant)} workflows with a time-based trigger.`,
      HTTP_CONFLICT,
    );
  }
}

/**
 * Every id a definition names has to resolve inside the caller's tenant.
 *
 * `validation_failed`, not `not_found`: row-level security means another
 * tenant's id is simply not visible, so the server cannot tell it from "no such
 * team" — and that indistinguishability is the point (ADR 0004). The refusal
 * names the field without confirming whether the id exists elsewhere.
 */
function assertWorkflowReferencesInTenant(
  principal: SessionPrincipal,
  conditions: readonly WorkflowCondition[],
  actions: readonly WorkflowAction[],
): void {
  for (const reference of definitionReferences(conditions, actions)) {
    if (referenceName(principal, reference.kind, reference.id) === null) {
      throw refused(
        'validation_failed',
        'That tag, team or agent is not in this workspace.',
        HTTP_UNPROCESSABLE,
      );
    }
  }
}

/**
 * A workflow may not be armed while any reference is dangling — the one new
 * error code ADR 0009 adds, and the one refusal the console handles differently:
 * the body is well-formed and the caller changed nothing, so the next action is
 * "pick a replacement", not "fix your input".
 */
function assertArmable(
  principal: SessionPrincipal,
  workflow: MockWorkflow,
  isActive: boolean | undefined,
): void {
  if (isActive !== true) {
    return;
  }

  const broken = workflowReferences(principal, workflow).filter((reference) => !reference.exists);

  if (broken.length > 0) {
    throw refused(
      'workflow_reference_broken',
      'This workflow points at something that no longer exists. Choose a replacement before turning it on.',
      HTTP_BAD_REQUEST,
    );
  }
}

/** Every taxonomy id the definition names, in a stable order, deduplicated. */
function definitionReferences(
  conditions: readonly WorkflowCondition[],
  actions: readonly WorkflowAction[],
): readonly { kind: WorkflowTaxonomyKind; id: string }[] {
  const found: { kind: WorkflowTaxonomyKind; id: string }[] = [];

  for (const condition of conditions) {
    if (condition.type === 'ticket_tag' || condition.type === 'contact_tag') {
      found.push(...condition.tagIds.map((id) => ({ kind: 'tag' as const, id })));
    }

    if (condition.type === 'ticket_assignment') {
      if (condition.teamId !== null) {
        found.push({ kind: 'team', id: condition.teamId });
      }

      if (condition.userId !== null) {
        found.push({ kind: 'user', id: condition.userId });
      }
    }
  }

  for (const action of actions) {
    if (action.type === 'add_ticket_tag') {
      found.push({ kind: 'tag', id: action.tagId });
    }

    if (action.type === 'reassign') {
      found.push(
        action.target.kind === 'team'
          ? { kind: 'team', id: action.target.teamId }
          : { kind: 'user', id: action.target.userId },
      );
    }

    if (action.type === 'notify') {
      if (action.userId !== null) {
        found.push({ kind: 'user', id: action.userId });
      }

      if (action.teamId !== null) {
        found.push({ kind: 'team', id: action.teamId });
      }
    }
  }

  // A workflow naming the same tag from two actions stores one reference, which
  // is what `workflow_references`' unique key gives the real implementation.
  const seen = new Set<string>();

  return found.filter((reference) => {
    const key = `${reference.kind}:${reference.id}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

/**
 * Resolved **live, on every read, and never stored** — ADR 0009 decision 6's
 * whole mechanism. A rename therefore needs no write to the workflow, and a
 * delete shows as `exists: false` rather than as a stale name that looks healthy.
 */
function workflowReferences(
  principal: SessionPrincipal,
  workflow: MockWorkflow,
): readonly WorkflowReference[] {
  return definitionReferences(workflow.conditions, workflow.actions).map((reference) => {
    const name = referenceName(principal, reference.kind, reference.id);

    return { kind: reference.kind, id: reference.id, name, exists: name !== null };
  });
}

/** `null` for an id this tenant has no row for — deleted, or another tenant's. */
function referenceName(
  principal: SessionPrincipal,
  kind: WorkflowTaxonomyKind,
  id: string,
): string | null {
  switch (kind) {
    case 'tag':
      return tenantTags(principal).find((tag) => tag.id === id)?.name ?? null;

    case 'team':
      return tenantTeams(principal).find((team) => team.id === id)?.name ?? null;

    case 'user':
      // A removed agent is a soft delete and stays in the store, so it is
      // excluded by name here — a workflow pointing at somebody who can no
      // longer sign in is exactly the broken reference this reports.
      return (
        tenantUsers(principal).find((user) => user.id === id && user.status !== 'removed')
          ?.displayName ?? null
      );
  }
}

function minutesSince(isoTimestamp: string): number {
  return (Date.now() - new Date(isoTimestamp).getTime()) / MS_PER_MINUTE;
}

function held(value: boolean): { held: boolean; reason: null } {
  return { held: value, reason: null };
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

function toContactResponse(contact: MockContact): ContactResponse {
  return stripTenant(contact);
}

function toCustomFieldDefinitionResponse(
  definition: MockCustomFieldDefinition,
): CustomFieldDefinition {
  return stripTenant(definition);
}

function toCannedResponseResponse(response: MockCannedResponse): CannedResponseResponse {
  return stripTenant(response);
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

/**
 * The two attribution columns ADR 0009 adds to `tickets` are internal, exactly
 * like `tenantId`: the dashboard groups by them and no ticket response carries
 * them. Stripped here rather than left to the response schema to drop, so the
 * transport is the boundary rather than the parser at the other end of it.
 */
function toTicketResponse(ticket: MockTicket): TicketResponse {
  const { firstResponseUserId, resolvedByUserId, ...scoped } = stripTenant(ticket);

  // The check is not decoration, and it is the same one `stripTenant` makes
  // about the tenant column: `null` is a recorded fact — "nobody was recorded" —
  // while `undefined` means a fixture or a write path built a ticket without
  // ever considering attribution. The first renders as the unattributed row; the
  // second would silently *become* that row, which is a fixture bug wearing a
  // valid answer's clothes.
  if (firstResponseUserId === undefined || resolvedByUserId === undefined) {
    throw new Error('Mock ticket is missing its reporting attribution.');
  }

  return scoped;
}

/**
 * The one serialiser that *adds* a field rather than only stripping one:
 * `references` is not stored, so it is joined on here from live rows — which is
 * why a rename elsewhere reaches the console with nothing republished.
 */
function toWorkflowResponse(principal: SessionPrincipal, workflow: MockWorkflow): WorkflowResponse {
  return {
    ...stripTenant(workflow),
    references: [...workflowReferences(principal, workflow)],
  };
}

function toWorkflowRunResponse(run: MockWorkflowRun): WorkflowRunResponse {
  return stripTenant(run);
}

function toKnowledgeDocumentResponse(document: MockKnowledgeDocument): KnowledgeDocumentResponse {
  return stripTenant(document);
}

/**
 * The response minus `content`, which is what the list endpoint publishes.
 *
 * Parsed through the contract's own schema rather than by deleting a key here,
 * so a field added to the list item reaches the mock without an edit and a field
 * removed from it stops being published.
 */
function toKnowledgeDocumentListItem(document: MockKnowledgeDocument): KnowledgeDocumentListItem {
  return KnowledgeDocumentListItemSchema.parse(toKnowledgeDocumentResponse(document));
}

// --- Helpers ---------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 25;
const MS_PER_MINUTE = 60_000;
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
