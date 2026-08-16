import 'server-only';

import {
  MOCK_ASSIGNMENT_RULES,
  MOCK_CONTACTS,
  MOCK_CONVERSATIONS,
  MOCK_CUSTOM_FIELD_DEFINITIONS,
  MOCK_INTERNAL_NOTES,
  MOCK_MESSAGES,
  MOCK_MESSAGE_TEMPLATES,
  MOCK_ONBOARDING_CHECKLISTS,
  MOCK_SLA_ALERTS,
  MOCK_TAGS,
  MOCK_TEAMS,
  MOCK_TENANTS,
  MOCK_TENANT_DOMAINS,
  MOCK_TENANT_LIFECYCLES,
  MOCK_TICKETS,
  MOCK_TICKET_EVENTS,
  MOCK_USERS,
  MOCK_WORKFLOWS,
  MOCK_WORKFLOW_RUNS,
  type MockAssignmentRule,
  type MockContact,
  type MockConversation,
  type MockCustomFieldDefinition,
  type MockInternalNote,
  type MockMessage,
  type MockMessageTemplate,
  type MockOnboardingChecklist,
  type MockSlaAlert,
  type MockTag,
  type MockTeam,
  type MockTenantDomain,
  type MockTenantLifecycle,
  type MockTicket,
  type MockTicketEvent,
  type MockUser,
  type MockWorkflow,
  type MockWorkflowRun,
} from '@/lib/api/mock/fixtures';
import type { TenantResponse } from '@whatsappcrm/contracts';

/**
 * Mutable in-memory state behind the mock transport, so an invite or a team
 * created in the UI is visible on the next render. Process-local and reset by a
 * restart — that is the correct lifetime for a fixture layer that exists only
 * until TAR-81's endpoints land.
 *
 * The `Map`s are keyed by id and hold *tenant-scoped* records. No reader in
 * `handlers.ts` is allowed to iterate them without filtering on `tenantId`.
 */

interface MockState {
  /**
   * Keyed by tenant id, not by the usual `tenantId` column: a tenant *is* the
   * scope, so the record has no separate one. Every reader still looks it up by
   * `principal.tenantId` and never iterates.
   */
  tenants: Map<string, TenantResponse>;
  tenantLifecycles: Map<string, MockTenantLifecycle>;
  users: Map<string, MockUser>;
  teams: Map<string, MockTeam>;
  contacts: Map<string, MockContact>;
  conversations: Map<string, MockConversation>;
  messages: Map<string, MockMessage>;
  internalNotes: Map<string, MockInternalNote>;
  messageTemplates: Map<string, MockMessageTemplate>;
  tickets: Map<string, MockTicket>;
  /**
   * Append-only, and treated as such: the handlers add rows and never rewrite
   * one. A history a fixture layer could edit is not a history.
   */
  ticketEvents: Map<string, MockTicketEvent>;
  tags: Map<string, MockTag>;
  customFieldDefinitions: Map<string, MockCustomFieldDefinition>;
  assignmentRules: Map<string, MockAssignmentRule>;
  workflows: Map<string, MockWorkflow>;
  /** A log rather than a ledger: nothing here is written by the console. */
  workflowRuns: Map<string, MockWorkflowRun>;
  slaAlerts: Map<string, MockSlaAlert>;
  /**
   * Keyed by **tenant**, not by an id of its own: a tenant has exactly one
   * checklist, and a surrogate key would invite a handler to look one up by
   * something other than the caller's tenant.
   */
  onboarding: Map<string, MockOnboardingChecklist>;
  /**
   * Keyed by row id, unlike `tenants` above — a tenant holds several hostnames,
   * and they are added, verified and removed one at a time (TAR-418).
   *
   * This is the mutable source of truth for domains. `tenants[].domains` is a
   * seed composed from the same fixture, and the tenant handler recomposes it
   * from this map on every read, so a verify cannot leave the tenant row stale.
   */
  tenantDomains: Map<string, MockTenantDomain>;
  /**
   * `Idempotency-Key` → the request it was spent on, and what it produced.
   *
   * The composer's whole double-send guard rests on the API remembering this, so
   * the mock transport remembers it too — a fixture layer that happily sent
   * twice would let the one bug this feature exists to prevent through review.
   * The serialised payload is kept alongside because the real endpoint replays
   * only an *identical* request and refuses a key reused with a different body.
   */
  sentByIdempotencyKey: Map<string, { payload: string; message: MockMessage }>;
  /** Monotonic counter for fabricated ids — never `Math.random()`, which would break resume. */
  nextId: number;
}

/**
 * Next's dev server re-evaluates modules on hot reload, which would otherwise
 * discard everything the reviewer just created. Parking state on `globalThis`
 * keeps it across reloads.
 */
const STATE_KEY = Symbol.for('whatsappcrm.web.mockState');

type GlobalWithState = typeof globalThis & { [STATE_KEY]?: MockState };

function seed(): MockState {
  return {
    tenants: new Map(
      MOCK_TENANTS.map((tenant) => [
        tenant.id,
        { ...tenant, branding: { ...tenant.branding }, domains: [...tenant.domains] },
      ]),
    ),
    tenantLifecycles: new Map(
      MOCK_TENANT_LIFECYCLES.map((lifecycle) => [
        lifecycle.tenantId,
        { ...lifecycle, plan: { ...lifecycle.plan } },
      ]),
    ),
    users: new Map(MOCK_USERS.map((user) => [user.id, { ...user, teamIds: [...user.teamIds] }])),
    teams: new Map(
      MOCK_TEAMS.map((team) => [team.id, { ...team, memberUserIds: [...team.memberUserIds] }]),
    ),
    contacts: new Map(
      // `tags` and `customFields` are both replaced wholesale by the update
      // handler, but copying them here is what stops one reset leaking a
      // mutation into the next.
      MOCK_CONTACTS.map((contact) => [
        contact.id,
        { ...contact, tags: [...contact.tags], customFields: { ...contact.customFields } },
      ]),
    ),
    conversations: new Map(
      MOCK_CONVERSATIONS.map((conversation) => [conversation.id, conversation]),
    ),
    messages: new Map(MOCK_MESSAGES.map((message) => [message.id, message])),
    internalNotes: new Map(MOCK_INTERNAL_NOTES.map((note) => [note.id, note])),
    messageTemplates: new Map(MOCK_MESSAGE_TEMPLATES.map((item) => [item.id, item])),
    tickets: new Map(MOCK_TICKETS.map((item) => [item.id, item])),
    ticketEvents: new Map(MOCK_TICKET_EVENTS.map((item) => [item.id, item])),
    tags: new Map(MOCK_TAGS.map((tag) => [tag.id, tag])),
    customFieldDefinitions: new Map(
      MOCK_CUSTOM_FIELD_DEFINITIONS.map((definition) => [
        definition.id,
        { ...definition, options: [...definition.options] },
      ]),
    ),
    assignmentRules: new Map(
      MOCK_ASSIGNMENT_RULES.map((rule) => [rule.id, { ...rule, conditions: [...rule.conditions] }]),
    ),
    workflows: new Map(
      MOCK_WORKFLOWS.map((workflow) => [
        workflow.id,
        { ...workflow, conditions: [...workflow.conditions], actions: [...workflow.actions] },
      ]),
    ),
    workflowRuns: new Map(MOCK_WORKFLOW_RUNS.map((run) => [run.id, run])),
    slaAlerts: new Map(MOCK_SLA_ALERTS.map((item) => [item.id, item])),
    onboarding: new Map(
      MOCK_ONBOARDING_CHECKLISTS.map((checklist) => [
        checklist.tenantId,
        // Deep enough: the handlers replace step objects rather than mutating
        // them, so copying the array is all that keeps one reset from leaking
        // into the next.
        { ...checklist, steps: checklist.steps.map((step) => ({ ...step })) },
      ]),
    ),
    tenantDomains: new Map(MOCK_TENANT_DOMAINS.map((domain) => [domain.id, domain])),
    sentByIdempotencyKey: new Map(),
    nextId: 1,
  };
}

export function mockState(): MockState {
  const container = globalThis as GlobalWithState;

  container[STATE_KEY] ??= seed();

  return container[STATE_KEY];
}

/** Test hook: restores the fixtures so cases cannot leak state into each other. */
export function resetMockState(): void {
  (globalThis as GlobalWithState)[STATE_KEY] = seed();
}

/**
 * Deterministic id generator in UUID shape, so fabricated records still satisfy
 * the contract's `IdSchema`.
 */
export function nextMockId(): string {
  const state = mockState();
  const suffix = state.nextId.toString(16).padStart(12, '0');

  state.nextId += 1;

  return `0192fe00-0000-7000-8000-${suffix}`;
}
