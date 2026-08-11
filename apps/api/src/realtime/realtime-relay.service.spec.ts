import {
  ServerEventSchema,
  conversationRoom,
  tenantRoom,
  type MessageResponse,
} from '@whatsappcrm/contracts';
import type { Server } from 'socket.io';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { MessageCreatedEvent, MessageStatusChangedEvent } from '../events/domain-events';
import type { MessageResourceService } from './message-resource.service';
import { RealtimeRelayService } from './realtime-relay.service';

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
  options: { message?: MessageResponse | null; readFails?: boolean; attach?: boolean } = {},
): Harness {
  const emissions: Emission[] = [];
  const scopes: (string | null)[] = [];
  const tenantContext = new TenantContextService();

  const messages = {
    findForRelay: (): Promise<MessageResponse | null> => {
      scopes.push(tenantContext.tenantId);

      if (options.readFails === true) {
        return Promise.reject(new Error('the database is unreachable'));
      }

      return Promise.resolve(options.message === undefined ? PUBLISHED : options.message);
    },
  } as unknown as MessageResourceService;

  const relay = new RealtimeRelayService(messages, tenantContext);

  if (options.attach !== false) {
    relay.attach(fakeServer(emissions));
  }

  return { relay, emissions, scopes };
}

/**
 * Just enough Socket.IO: `to()` accumulates room names and returns something
 * chainable, and `emit` records what was addressed to them. Socket.IO's own
 * de-duplication of a socket in two of those rooms is its concern, not this
 * file's — what is under test is *which rooms are named*.
 */
function fakeServer(emissions: Emission[]): Server {
  const build = (rooms: string[]): unknown => ({
    to: (room: string) => build([...rooms, room]),
    emit: (event: string, payload: unknown) => {
      emissions.push({ rooms, event, payload });
      return true;
    },
  });

  return build([]) as Server;
}

describe('relaying message.created', () => {
  it('addresses the tenant and conversation rooms named by the event', async () => {
    const { relay, emissions } = harnessFor();

    await relay.onMessageCreated(created());

    expect(emissions).toEqual([
      {
        rooms: [tenantRoom(TENANT), conversationRoom(CONVERSATION)],
        event: 'message.created',
        payload: { event: 'message.created', conversationId: CONVERSATION, message: PUBLISHED },
      },
    ]);
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
});

describe('relaying a send-status transition', () => {
  it.each(['queued', 'sent', 'delivered', 'read', 'failed'] as const)(
    'puts %s on the wire with the message it describes',
    async (status) => {
      const { relay, emissions } = harnessFor({ message: { ...PUBLISHED, status } });

      await relay.onMessageStatusChanged(statusChanged({ status }));

      expect(emissions[0]).toEqual({
        rooms: [tenantRoom(TENANT), conversationRoom(CONVERSATION)],
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
    const { relay, emissions } = harnessFor();

    await relay.onMessageStatusChanged(statusChanged());
    await relay.onMessageStatusChanged(statusChanged({ tenantId: other }));

    expect(emissions.map((emission) => emission.rooms[0])).toEqual([
      tenantRoom(TENANT),
      tenantRoom(other),
    ]);
  });
});
