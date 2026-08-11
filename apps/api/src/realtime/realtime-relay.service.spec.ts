import {
  ServerEventSchema,
  conversationAudienceRooms,
  conversationRoom,
  teamRoom,
  tenantReadersRoom,
  tenantRoom,
  userRoom,
  type ConversationAudience,
  type ConversationResponse,
  type MessageResponse,
} from '@whatsappcrm/contracts';
import type { Server } from 'socket.io';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type {
  ConversationAssignedEvent,
  MessageCreatedEvent,
  MessageStatusChangedEvent,
} from '../events/domain-events';
import type { SessionService } from '../identity/session.service';
import type { ConversationResourceService } from './conversation-resource.service';
import type { MessageResourceService, RelayableMessage } from './message-resource.service';
import { RealtimeRelayService } from './realtime-relay.service';
import type { TenantHostnameService } from './tenant-hostname.service';

/**
 * What reaches the rooms when the ingestion pipeline emits (TAR-69).
 *
 * Two properties are load-bearing rather than incidental. The rooms are built
 * from the **event's** ids, so a relay cannot be pointed anywhere by anything a
 * client did; and the read happens inside a scope opened from the event's own
 * tenant, so the row that gets published is fetched under that tenant's RLS
 * rather than under whatever scope the emitter happened to leave behind.
 */

const TENANT = '80111111-1111-7111-8111-111111111101';
const ASSIGNEE = '80111111-1111-7111-8111-1111111111a1';
/** The agent a thread is handed *to*, for the cases where two owners matter. */
const SUCCESSOR = '80111111-1111-7111-8111-1111111111a2';
const TEAM = '80111111-1111-7111-8111-1111111111b1';
const CONVERSATION = '80111111-1111-7111-8111-1111111111c1';
const MESSAGE = '80111111-1111-7111-8111-1111111111d1';
const CONTACT = '80111111-1111-7111-8111-1111111111b9';

const PUBLISHED: MessageResponse = {
  id: MESSAGE,
  conversationId: CONVERSATION,
  direction: 'inbound',
  type: 'text',
  status: 'delivered',
  body: 'is my order on its way?',
  attachments: [],
  sentByUserId: null,
  sentByAutomation: false,
  providerMessageId: 'wamid.abc',
  failureReason: null,
  sentAt: '2026-08-11T09:00:00.000Z',
  createdAt: '2026-08-11T09:00:01.000Z',
};

function created(overrides: Partial<MessageCreatedEvent> = {}): MessageCreatedEvent {
  return {
    tenantId: TENANT,
    conversationId: CONVERSATION,
    contactId: CONTACT,
    messageId: MESSAGE,
    direction: 'inbound',
    status: 'received',
    contentType: 'text',
    body: 'is my order on its way?',
    providerMessageId: 'wamid.abc',
    sentAt: new Date('2026-08-11T09:00:00.000Z'),
    ...overrides,
  };
}

function statusChanged(
  overrides: Partial<MessageStatusChangedEvent> = {},
): MessageStatusChangedEvent {
  return {
    tenantId: TENANT,
    conversationId: CONVERSATION,
    messageId: MESSAGE,
    status: 'delivered',
    providerMessageId: 'wamid.abc',
    ...overrides,
  };
}

/** The thread as `GET /conversations/{id}` publishes it, unclaimed by default. */
function conversation(overrides: Partial<ConversationResponse> = {}): ConversationResponse {
  return {
    id: CONVERSATION,
    contact: {
      id: CONTACT,
      phone: '+966500000001',
      waProfileName: 'Maria',
      displayName: 'Maria',
      email: null,
      tags: [],
      customFields: {},
      lastContactedAt: null,
      optedOutAt: null,
      createdAt: '2026-08-11T08:00:00.000Z',
      updatedAt: '2026-08-11T08:00:00.000Z',
    },
    whatsappAccountId: '80111111-1111-7111-8111-1111111111e1',
    status: 'open',
    assignedUserId: null,
    assignedTeamId: null,
    ticketId: null,
    unreadCount: 1,
    serviceWindowExpiresAt: null,
    botHandling: false,
    lastMessagePreview: 'is my order on its way?',
    lastMessageAt: '2026-08-11T09:00:00.000Z',
    createdAt: '2026-08-11T08:00:00.000Z',
    updatedAt: '2026-08-11T09:00:02.000Z',
    ...overrides,
  };
}

/** A hand-over from nobody — the claim of an unclaimed thread — by default. */
function assigned(overrides: Partial<ConversationAssignedEvent> = {}): ConversationAssignedEvent {
  return {
    tenantId: TENANT,
    conversationId: CONVERSATION,
    previousAssignedUserId: null,
    previousAssignedTeamId: null,
    ...overrides,
  };
}

interface Emission {
  readonly rooms: string[];
  readonly event: string;
  readonly payload: unknown;
}

interface Harness {
  readonly relay: RealtimeRelayService;
  readonly emissions: Emission[];
  /** The tenant in scope each time a message was read back. */
  readonly scopes: (string | null)[];
}

function harnessFor(
  options: {
    message?: MessageResponse | null;
    conversation?: ConversationResponse | null;
    audience?: Partial<ConversationAudience>;
    readFails?: boolean;
    attach?: boolean;
    hostname?: boolean;
  } = {},
): Harness {
  const emissions: Emission[] = [];
  const scopes: (string | null)[] = [];
  const tenantContext = new TenantContextService();

  const messages = {
    findForRelay: (): Promise<RelayableMessage | null> => {
      scopes.push(tenantContext.tenantId);

      if (options.readFails === true) {
        return Promise.reject(new Error('the database is unreachable'));
      }

      const message = options.message === undefined ? PUBLISHED : options.message;

      return Promise.resolve(
        message === null
          ? null
          : {
              message,
              audience: {
                tenantId: TENANT,
                assignedUserId: null,
                assignedTeamId: null,
                ...options.audience,
              },
            },
      );
    },
  } as unknown as MessageResourceService;

  const conversations = {
    findForRelay: (): Promise<ConversationResponse | null> => {
      scopes.push(tenantContext.tenantId);

      if (options.readFails === true) {
        return Promise.reject(new Error('the database is unreachable'));
      }

      return Promise.resolve(
        options.conversation === undefined ? conversation() : options.conversation,
      );
    },
  } as unknown as ConversationResourceService;

  const hostnames = {
    publish: (): Promise<boolean> => {
      if (options.hostname === false) {
        return Promise.resolve(false);
      }

      tenantContext.setHostname('acme.app.localhost');

      return Promise.resolve(true);
    },
  } as unknown as TenantHostnameService;

  const sessions = {
    resolveBySessionId: (): Promise<null> => Promise.resolve(null),
  } as unknown as SessionService;

  const relay = new RealtimeRelayService(
    messages,
    conversations,
    hostnames,
    sessions,
    tenantContext,
  );

  if (options.attach !== false) {
    relay.attach(fakeServer(emissions));
  }

  return { relay, emissions, scopes };
}

/**
 * Just enough Socket.IO: `to()` records the room list it was handed and `emit`
 * records what was addressed to it. Socket.IO's own de-duplication of a socket
 * in two of those rooms is its concern, not this file's — what is under test is
 * *which rooms are named*, because that set is the authorization boundary.
 */
function fakeServer(emissions: Emission[]): Server {
  return {
    to: (rooms: string[]) => ({
      emit: (event: string, payload: unknown) => {
        emissions.push({ rooms, event, payload });
        return true;
      },
    }),
  } as unknown as Server;
}

describe('the rooms a message is addressed to', () => {
  /**
   * One case per branch of `isVisibleOrUnclaimed`. This is the regression net
   * for the review's blocking finding: the first published fan-out sent every
   * message to `tenant:{id}`, which handed an agent the body and attachment
   * URLs of threads the REST API answers `not_found` for.
   */
  it('sends an unclaimed thread to every agent in the tenant, and the readers', async () => {
    const { relay, emissions } = harnessFor();

    await relay.onMessageCreated(created());

    expect(emissions[0]?.rooms).toEqual([tenantReadersRoom(TENANT), tenantRoom(TENANT)]);
  });

  it('sends a claimed thread to its assignee and the readers, and nobody else', async () => {
    const { relay, emissions } = harnessFor({ audience: { assignedUserId: ASSIGNEE } });

    await relay.onMessageCreated(created());

    // The tenant room is absent, which is the whole point: an agent who is not
    // the assignee, holds no `conversation:read_all` and is in no relevant team
    // is in none of these rooms.
    expect(emissions[0]?.rooms).toEqual([tenantReadersRoom(TENANT), userRoom(ASSIGNEE)]);
    expect(emissions[0]?.rooms).not.toContain(tenantRoom(TENANT));
  });

  it('sends a team-routed thread to that team and the readers', async () => {
    const { relay, emissions } = harnessFor({ audience: { assignedTeamId: TEAM } });

    await relay.onMessageCreated(created());

    expect(emissions[0]?.rooms).toEqual([tenantReadersRoom(TENANT), teamRoom(TEAM)]);
  });

  it('never addresses the conversation room, so a claimed thread loses its old watchers', async () => {
    // A subscription authorised while the thread was unclaimed must not keep
    // publishing once somebody else claims it — the audience follows the
    // assignment, not the other way round.
    const { relay, emissions } = harnessFor({ audience: { assignedUserId: ASSIGNEE } });

    await relay.onMessageCreated(created());

    expect(emissions[0]?.rooms).not.toContain(conversationRoom(CONVERSATION));
  });

  it('matches the contract’s own published fan-out rather than restating it', async () => {
    const audience = { tenantId: TENANT, assignedUserId: null, assignedTeamId: TEAM };
    const { relay, emissions } = harnessFor({ audience });

    await relay.onMessageCreated(created());

    expect(emissions[0]?.rooms).toEqual(conversationAudienceRooms(audience));
  });
});

describe('relaying message.created', () => {
  it('publishes the whole resource under the event’s own name', async () => {
    const { relay, emissions } = harnessFor();

    await relay.onMessageCreated(created());

    expect(emissions[0]?.event).toBe('message.created');
    expect(emissions[0]?.payload).toEqual({
      event: 'message.created',
      conversationId: CONVERSATION,
      message: PUBLISHED,
    });
  });

  it('publishes a payload the contract accepts, carrying the whole resource', async () => {
    const { relay, emissions } = harnessFor();

    await relay.onMessageCreated(created());

    expect(ServerEventSchema.safeParse(emissions[0]?.payload).success).toBe(true);
  });

  it('reads the message back inside the event’s own tenant scope', async () => {
    const { relay, scopes } = harnessFor();

    await relay.onMessageCreated(created());

    expect(scopes).toEqual([TENANT]);
  });

  it('relays nothing when the message is already gone', async () => {
    const { relay, emissions } = harnessFor({ message: null });

    await relay.onMessageCreated(created());

    expect(emissions).toEqual([]);
  });

  it('swallows a failed read rather than rejecting into the emitter', async () => {
    // `@OnEvent` handlers are dispatched without an await, so a rejection here
    // is an unhandled promise. A missed relay costs a client one refetch; taking
    // the process down costs everybody the API.
    const { relay, emissions } = harnessFor({ readFails: true });

    await expect(relay.onMessageCreated(created())).resolves.toBeUndefined();
    expect(emissions).toEqual([]);
  });

  it('does nothing at all before a server is attached', async () => {
    const { relay } = harnessFor({ attach: false });

    await expect(relay.onMessageCreated(created())).resolves.toBeUndefined();
  });

  it('relays nothing for a tenant with no verified host to name', async () => {
    // A payload can carry an absolute attachment URL, and there is no origin to
    // build one against. Costs nothing real: a tenant with no verified domain
    // has no host `HostTenantGuard` resolves, so nobody is signed in to it.
    const { relay, emissions } = harnessFor({ hostname: false });

    await relay.onMessageCreated(created());

    expect(emissions).toEqual([]);
  });
});

describe('relaying a send-status transition', () => {
  it.each(['queued', 'sent', 'delivered', 'read', 'failed'] as const)(
    'puts %s on the wire with the message it describes',
    async (status) => {
      const { relay, emissions } = harnessFor({ message: { ...PUBLISHED, status } });

      await relay.onMessageStatusChanged(statusChanged({ status }));

      expect(emissions[0]).toEqual({
        rooms: [tenantReadersRoom(TENANT), tenantRoom(TENANT)],
        event: 'message.status_changed',
        payload: {
          event: 'message.status_changed',
          conversationId: CONVERSATION,
          messageId: MESSAGE,
          message: { ...PUBLISHED, status },
        },
      });
      expect(ServerEventSchema.safeParse(emissions[0]?.payload).success).toBe(true);
    },
  );

  it('keeps two tenants’ events in their own rooms', async () => {
    const other = '80111111-1111-7111-8111-111111111102';
    const mine = harnessFor();
    const theirs = harnessFor({ audience: { tenantId: other } });

    await mine.relay.onMessageStatusChanged(statusChanged());
    await theirs.relay.onMessageStatusChanged(statusChanged({ tenantId: other }));

    // Every room name is built from the row's own tenant, so no name can appear
    // in both sets — which is the property, rather than the particular strings.
    const roomsOf = (harness: Harness): string[] => harness.emissions[0]?.rooms ?? [];

    expect(roomsOf(mine)).toEqual([tenantReadersRoom(TENANT), tenantRoom(TENANT)]);
    expect(roomsOf(theirs)).toEqual([tenantReadersRoom(other), tenantRoom(other)]);
    expect(roomsOf(mine).some((room) => roomsOf(theirs).includes(room))).toBe(false);
  });

  it('reads each event back inside its own tenant scope', async () => {
    const other = '80111111-1111-7111-8111-111111111102';
    const { relay, scopes } = harnessFor();

    await relay.onMessageStatusChanged(statusChanged());
    await relay.onMessageStatusChanged(statusChanged({ tenantId: other }));

    expect(scopes).toEqual([TENANT, other]);
  });
});

/**
 * The rooms a claim is addressed to (TAR-198).
 *
 * This is the one relay that addresses **two** audiences, and the reason is the
 * acceptance criterion itself: the audience of a conversation is derived from its
 * assignment, so an agent who was watching an unclaimed thread is in none of the
 * rooms the claimed thread now addresses. Emitting only to the new audience would
 * deliver "somebody has this now" to everybody except the people it is news for.
 *
 * Each case below is one shape of hand-over, and each asserts both halves: who
 * hears about it, and — the part that keeps the fan-out honest — who does not.
 */
describe('the rooms a conversation hand-over is addressed to', () => {
  it('reaches every agent who could see the unclaimed thread, and its new owner', async () => {
    // The claim. `tenant:{id}` is in the set because the thread *was* unclaimed,
    // which is exactly how the colleague who was looking at it finds out.
    const { relay, emissions } = harnessFor({
      conversation: conversation({ assignedUserId: ASSIGNEE }),
    });

    await relay.onConversationAssigned(assigned());

    expect(emissions[0]?.rooms).toEqual([
      tenantReadersRoom(TENANT),
      tenantRoom(TENANT),
      userRoom(ASSIGNEE),
    ]);
  });

  it('reaches both agents of a hand-over, and nobody else in the tenant', async () => {
    const { relay, emissions } = harnessFor({
      conversation: conversation({ assignedUserId: SUCCESSOR }),
    });

    await relay.onConversationAssigned(assigned({ previousAssignedUserId: ASSIGNEE }));

    // No tenant room: a thread moving between two agents is not news the rest of
    // the tenant is entitled to, and the payload is the whole resource — the
    // customer, the preview, the unread count.
    expect(emissions[0]?.rooms).toEqual([
      tenantReadersRoom(TENANT),
      userRoom(ASSIGNEE),
      userRoom(SUCCESSOR),
    ]);
    expect(emissions[0]?.rooms).not.toContain(tenantRoom(TENANT));
  });

  it('puts a released thread back in front of every agent, and tells the agent who let it go', async () => {
    const { relay, emissions } = harnessFor({ conversation: conversation() });

    await relay.onConversationAssigned(assigned({ previousAssignedUserId: ASSIGNEE }));

    expect(emissions[0]?.rooms).toEqual([
      tenantReadersRoom(TENANT),
      userRoom(ASSIGNEE),
      tenantRoom(TENANT),
    ]);
  });

  it('reaches the team a thread is routed to as well as the agent who held it', async () => {
    const { relay, emissions } = harnessFor({
      conversation: conversation({ assignedTeamId: TEAM }),
    });

    await relay.onConversationAssigned(assigned({ previousAssignedUserId: ASSIGNEE }));

    expect(emissions[0]?.rooms).toEqual([
      tenantReadersRoom(TENANT),
      userRoom(ASSIGNEE),
      teamRoom(TEAM),
    ]);
  });

  it('is exactly the two audiences the contract publishes, unioned', async () => {
    const published = conversation({ assignedUserId: SUCCESSOR });
    const { relay, emissions } = harnessFor({ conversation: published });

    await relay.onConversationAssigned(assigned({ previousAssignedTeamId: TEAM }));

    expect(emissions[0]?.rooms).toEqual([
      ...new Set([
        ...conversationAudienceRooms({
          tenantId: TENANT,
          assignedUserId: null,
          assignedTeamId: TEAM,
        }),
        ...conversationAudienceRooms({
          tenantId: TENANT,
          assignedUserId: SUCCESSOR,
          assignedTeamId: null,
        }),
      ]),
    ]);
  });

  it('names the readers room once, not once per audience', async () => {
    const { relay, emissions } = harnessFor({
      conversation: conversation({ assignedUserId: SUCCESSOR }),
    });

    await relay.onConversationAssigned(assigned({ previousAssignedUserId: ASSIGNEE }));

    const rooms = emissions[0]?.rooms ?? [];

    expect(rooms.filter((room) => room === tenantReadersRoom(TENANT))).toHaveLength(1);
  });

  it('never addresses the conversation room', async () => {
    // Redundant as well as wrong here: a socket may only join that room if it was
    // in the audience at the time, so every subscriber is already in the previous
    // audience this emit addresses.
    const { relay, emissions } = harnessFor({
      conversation: conversation({ assignedUserId: ASSIGNEE }),
    });

    await relay.onConversationAssigned(assigned());

    expect(emissions[0]?.rooms).not.toContain(conversationRoom(CONVERSATION));
  });

  it('derives the new audience from the row it read back, never from the event', async () => {
    // The event deliberately carries no new assignment. If the relay ever grew
    // one, this is the test that would fail: the committed row says the thread is
    // the successor's, and that is what decides who may see the payload.
    const { relay, emissions } = harnessFor({
      conversation: conversation({ assignedUserId: SUCCESSOR }),
    });

    await relay.onConversationAssigned(assigned({ previousAssignedUserId: ASSIGNEE }));

    expect(emissions[0]?.rooms).toContain(userRoom(SUCCESSOR));
  });

  it('keeps two tenants’ hand-overs in their own rooms', async () => {
    const other = '80111111-1111-7111-8111-111111111102';
    const mine = harnessFor({ conversation: conversation({ assignedUserId: ASSIGNEE }) });
    const theirs = harnessFor({ conversation: conversation({ assignedUserId: ASSIGNEE }) });

    await mine.relay.onConversationAssigned(assigned());
    await theirs.relay.onConversationAssigned(assigned({ tenantId: other }));

    const roomsOf = (harness: Harness): string[] => harness.emissions[0]?.rooms ?? [];

    // Every tenant-scoped name is built from the event's own tenant, so the two
    // sets share only the assignee room — which is a globally unique user id.
    expect(roomsOf(mine)).toContain(tenantRoom(TENANT));
    expect(roomsOf(theirs)).toContain(tenantRoom(other));
    expect(roomsOf(theirs)).not.toContain(tenantRoom(TENANT));
    expect(roomsOf(mine)).not.toContain(tenantRoom(other));
  });
});

describe('relaying a conversation hand-over', () => {
  it('publishes the whole conversation under the contract’s own event name', async () => {
    const published = conversation({ assignedUserId: ASSIGNEE });
    const { relay, emissions } = harnessFor({ conversation: published });

    await relay.onConversationAssigned(assigned());

    expect(emissions[0]?.event).toBe('conversation.updated');
    expect(emissions[0]?.payload).toEqual({
      event: 'conversation.updated',
      conversation: published,
    });
    expect(ServerEventSchema.safeParse(emissions[0]?.payload).success).toBe(true);
  });

  it('reads the conversation back inside the event’s own tenant scope', async () => {
    const { relay, scopes } = harnessFor();

    await relay.onConversationAssigned(assigned());

    expect(scopes).toEqual([TENANT]);
  });

  it('relays nothing when the conversation is already gone', async () => {
    const { relay, emissions } = harnessFor({ conversation: null });

    await relay.onConversationAssigned(assigned());

    expect(emissions).toEqual([]);
  });

  it('swallows a failed read rather than rejecting into the emitter', async () => {
    const { relay, emissions } = harnessFor({ readFails: true });

    await expect(relay.onConversationAssigned(assigned())).resolves.toBeUndefined();
    expect(emissions).toEqual([]);
  });

  it('does nothing at all before a server is attached', async () => {
    const { relay } = harnessFor({ attach: false });

    await expect(relay.onConversationAssigned(assigned())).resolves.toBeUndefined();
  });

  it('needs no hostname, because a conversation carries no absolute URL', async () => {
    // The asymmetry with the message path, asserted so it cannot regress into a
    // silent drop: a tenant with no verified domain still gets its hand-overs.
    const { relay, emissions } = harnessFor({ hostname: false });

    await relay.onConversationAssigned(assigned());

    expect(emissions).toHaveLength(1);
  });
});
