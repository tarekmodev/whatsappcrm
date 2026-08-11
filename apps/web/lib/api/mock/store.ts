import 'server-only';

import {
  MOCK_CONVERSATIONS,
  MOCK_INTERNAL_NOTES,
  MOCK_MESSAGES,
  MOCK_TEAMS,
  MOCK_USERS,
  type MockConversation,
  type MockInternalNote,
  type MockMessage,
  type MockTeam,
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
