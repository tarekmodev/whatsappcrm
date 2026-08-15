import 'server-only';

import {
  MOCK_ASSIGNMENT_RULES,
  MOCK_CONVERSATIONS,
  MOCK_CUSTOM_FIELD_DEFINITIONS,
  MOCK_INTERNAL_NOTES,
  MOCK_MESSAGES,
  MOCK_MESSAGE_TEMPLATES,
  MOCK_SLA_ALERTS,
  MOCK_TAGS,
  MOCK_TEAMS,
  MOCK_TICKETS,
  MOCK_USERS,
  type MockAssignmentRule,
  type MockConversation,
  type MockCustomFieldDefinition,
  type MockInternalNote,
  type MockMessage,
  type MockMessageTemplate,
  type MockSlaAlert,
  type MockTag,
  type MockTeam,
  type MockTicket,
  type MockUser,
} from '@/lib/api/mock/fixtures';

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
  users: Map<string, MockUser>;
  teams: Map<string, MockTeam>;
  conversations: Map<string, MockConversation>;
  messages: Map<string, MockMessage>;
  internalNotes: Map<string, MockInternalNote>;
  messageTemplates: Map<string, MockMessageTemplate>;
  tickets: Map<string, MockTicket>;
  tags: Map<string, MockTag>;
  customFieldDefinitions: Map<string, MockCustomFieldDefinition>;
  assignmentRules: Map<string, MockAssignmentRule>;
  slaAlerts: Map<string, MockSlaAlert>;
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
    users: new Map(MOCK_USERS.map((user) => [user.id, { ...user, teamIds: [...user.teamIds] }])),
    teams: new Map(
      MOCK_TEAMS.map((team) => [team.id, { ...team, memberUserIds: [...team.memberUserIds] }]),
    ),
    conversations: new Map(
      MOCK_CONVERSATIONS.map((conversation) => [conversation.id, conversation]),
    ),
    messages: new Map(MOCK_MESSAGES.map((message) => [message.id, message])),
    internalNotes: new Map(MOCK_INTERNAL_NOTES.map((note) => [note.id, note])),
    messageTemplates: new Map(MOCK_MESSAGE_TEMPLATES.map((item) => [item.id, item])),
    tickets: new Map(MOCK_TICKETS.map((item) => [item.id, item])),
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
    slaAlerts: new Map(MOCK_SLA_ALERTS.map((item) => [item.id, item])),
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
