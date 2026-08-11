import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  conversationRoom,
  permissionsForRole,
  tenantRoom,
  userRoom,
  type ConversationAudience,
  type MessageResponse,
  type SessionPrincipal,
  type TenantRole,
} from '@whatsappcrm/contracts';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { MessageCreatedEvent } from '../events/domain-events';
import { SessionService } from '../identity/session.service';
import { ConversationAccessService } from './conversation-access.service';
import { MessageResourceService, type RelayableMessage } from './message-resource.service';
import { REALTIME_PATH } from './realtime.constants';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeHandshakeService } from './realtime-handshake.service';
import { RealtimeRelayService } from './realtime-relay.service';
import type { RealtimeSocketData } from './realtime-socket';
import { TenantHostnameService } from './tenant-hostname.service';

/**
 * The gateway against a real Socket.IO server and real clients (TAR-69).
 *
 * The acceptance criteria this file exists for are the ones no unit test can
 * make convincing, because they are claims about what a *client* can do:
 *
 *   * a connection without a valid ticket is refused;
 *   * a client cannot reach another tenant's room by naming one — asserted by
 *     trying, over every event name a client could plausibly invent, and then
 *     showing the room is still empty and its traffic still does not arrive;
 *   * `conversation.subscribe` is refused for a conversation outside the
 *     caller's tenant;
 *   * a relayed `message.created` reaches a subscribed client whole.
 *
 * Only the two things that talk to the database are stubbed — the handshake's
 * session lookup and the conversation visibility check. Everything below them is
 * the real gateway, the real relay, the real rooms and the real wire.
 */

const TENANT_A = '80111111-1111-7111-8111-111111111101';
const TENANT_B = '80111111-1111-7111-8111-111111111102';
const USER_A = '80111111-1111-7111-8111-1111111111a1';
const USER_B = '80111111-1111-7111-8111-1111111111a2';
const BYSTANDER = '80111111-1111-7111-8111-1111111111a3';
const SUPERVISOR = '80111111-1111-7111-8111-1111111111a4';
const CONVERSATION_A = '80111111-1111-7111-8111-1111111111c1';
const CONVERSATION_B = '80111111-1111-7111-8111-1111111111c2';
const MESSAGE = '80111111-1111-7111-8111-1111111111d1';

/** Which ticket string stands for which principal, so a test can hand one out. */
const TICKETS: Readonly<Record<string, SessionPrincipal>> = {
  'ticket-a': principal(TENANT_A, USER_A),
  'ticket-b': principal(TENANT_B, USER_B),
  /** A second agent in tenant A, in no team and holding no `conversation:read_all`. */
  'ticket-bystander': principal(TENANT_A, BYSTANDER),
  'ticket-supervisor': principal(TENANT_A, SUPERVISOR, 'supervisor'),
};

/** Conversations a principal may subscribe to, keyed by tenant. */
const VISIBLE_CONVERSATIONS: Readonly<Record<string, string>> = {
  [TENANT_A]: CONVERSATION_A,
  [TENANT_B]: CONVERSATION_B,
};

const PUBLISHED: MessageResponse = {
  id: MESSAGE,
  conversationId: CONVERSATION_A,
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

function principal(tenantId: string, userId: string, role: TenantRole = 'agent'): SessionPrincipal {
  return {
    userId,
    tenantId,
    email: `${userId}@acme.invalid`,
    displayName: 'Ada Agent',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: '80111111-1111-7111-8111-1111111111f1',
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

/** The port Node bound, once `listen(0)` has chosen one. */
function portOf(app: INestApplication): number {
  const address = (app.getHttpServer() as { address: () => unknown }).address();

  if (typeof address !== 'object' || address === null || !('port' in address)) {
    throw new Error('The test server is not listening on a TCP port.');
  }

  return (address as { port: number }).port;
}

function messageCreated(conversationId: string, tenantId: string): MessageCreatedEvent {
  return {
    tenantId,
    conversationId,
    contactId: '80111111-1111-7111-8111-1111111111b9',
    messageId: MESSAGE,
    direction: 'inbound',
    status: 'received',
    contentType: 'text',
    body: 'is my order on its way?',
    providerMessageId: 'wamid.abc',
    sentAt: new Date('2026-08-11T09:00:00.000Z'),
  };
}

describe('the realtime gateway', () => {
  let app: INestApplication;
  let relay: RealtimeRelayService;
  let gateway: RealtimeGateway;
  let url: string;
  /** Shared with the stubs below, which read the scope the relay opened. */
  const tenantContext = new TenantContextService();
  const clients: ClientSocket[] = [];

  /**
   * Who currently holds the conversation being relayed. Mutable because the
   * audience is what the fan-out is derived from, so a test changes this rather
   * than the event.
   */
  let audience: ConversationAudience = {
    tenantId: TENANT_A,
    assignedUserId: null,
    assignedTeamId: null,
  };

  beforeAll(async () => {
    const handshake = {
      authenticate: (auth: unknown): Promise<RealtimeSocketData | null> => {
        const ticket = (auth as { ticket?: unknown } | null)?.ticket;
        const resolved = typeof ticket === 'string' ? TICKETS[ticket] : undefined;

        return Promise.resolve(
          resolved === undefined
            ? null
            : { principal: resolved, requestId: `req-${resolved.userId}` },
        );
      },
    };

    const conversations = {
      maySubscribe: (caller: SessionPrincipal, conversationId: string): Promise<boolean> =>
        // Stands in for RLS plus TAR-22's visibility rule: a conversation
        // outside the caller's tenant is simply not one of theirs.
        Promise.resolve(VISIBLE_CONVERSATIONS[caller.tenantId] === conversationId),
    };

    const messages = {
      findForRelay: (): Promise<RelayableMessage | null> =>
        Promise.resolve({
          message: PUBLISHED,
          // The real service reads the row under the scope the relay opened, so
          // the audience's tenant is always the event's. Taking it from the
          // scope here rather than from the fixture keeps the stub honest for
          // the cross-tenant cases.
          audience: { ...audience, tenantId: tenantContext.requireTenantId() },
        }),
    } as unknown as MessageResourceService;

    const hostnames = {
      publish: (): Promise<boolean> => Promise.resolve(true),
    } as unknown as TenantHostnameService;

    const sessions = {
      resolveBySessionId: (): Promise<null> => Promise.resolve(null),
    } as unknown as SessionService;

    const moduleRef = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        RealtimeRelayService,
        { provide: TenantContextService, useValue: tenantContext },
        { provide: RealtimeHandshakeService, useValue: handshake },
        { provide: ConversationAccessService, useValue: conversations },
        { provide: MessageResourceService, useValue: messages },
        { provide: TenantHostnameService, useValue: hostnames },
        { provide: SessionService, useValue: sessions },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Port 0 so the suite never collides with a developer's running API. The
    // address is read from the server rather than from `getUrl()`, which answers
    // an IPv6 literal on some hosts that the client then cannot parse.
    await app.listen(0);

    relay = app.get(RealtimeRelayService);
    gateway = app.get(RealtimeGateway);
    url = `http://127.0.0.1:${portOf(app)}`;
  });

  afterEach(() => {
    audience = { tenantId: TENANT_A, assignedUserId: null, assignedTeamId: null };

    while (clients.length > 0) {
      const client = clients.pop();

      client?.removeAllListeners();
      client?.close();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  function connect(auth: Record<string, unknown>): ClientSocket {
    const client = io(url, {
      path: REALTIME_PATH,
      transports: ['websocket'],
      auth,
      forceNew: true,
      // A refused handshake is the expected outcome of half this file. Left on,
      // the client would keep retrying it on a timer that outlives the test.
      reconnection: false,
    });

    clients.push(client);

    return client;
  }

  /** Resolves on connect, rejects with the refusal message on `connect_error`. */
  async function connected(client: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      client.on('connect', resolve);
      client.on('connect_error', (error: Error) => {
        reject(error);
      });
    });
  }

  function roomMembers(room: string): number {
    return gatewayServer().sockets.adapter.rooms.get(room)?.size ?? 0;
  }

  function gatewayServer(): { sockets: { adapter: { rooms: Map<string, Set<string>> } } } {
    return (
      gateway as unknown as {
        server: { sockets: { adapter: { rooms: Map<string, Set<string>> } } };
      }
    ).server;
  }

  /** The next payload for `event`, or `null` if none arrives within `ms`. */
  async function nextEvent(client: ClientSocket, event: string, ms = 250): Promise<unknown> {
    return await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, ms);

      client.on(event, (payload: unknown) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  describe('the handshake', () => {
    it.each([
      ['no auth payload at all', {}],
      ['an empty ticket', { ticket: '' }],
      ['a ticket nobody issued', { ticket: 'ticket-forged' }],
      ['something that is not a ticket', { ticket: 42 }],
    ])('refuses a connection with %s', async (_case, auth) => {
      await expect(connected(connect(auth))).rejects.toThrow('unauthorized');
    });

    it('admits a connection presenting a valid ticket', async () => {
      await expect(connected(connect({ ticket: 'ticket-a' }))).resolves.toBeUndefined();
    });

    it('joins the tenant and user rooms the server resolved, and no others', async () => {
      const client = connect({ ticket: 'ticket-a' });
      await connected(client);

      expect(roomMembers(tenantRoom(TENANT_A))).toBe(1);
      expect(roomMembers(userRoom(USER_A))).toBe(1);
      expect(roomMembers(tenantRoom(TENANT_B))).toBe(0);
    });
  });

  describe('a client trying to name its own room', () => {
    it.each([
      'join',
      'subscribe',
      'room',
      'room.join',
      'tenant.subscribe',
      'conversation.subscribe',
    ])('cannot get into another tenant’s room by emitting %s', async (event) => {
      const client = connect({ ticket: 'ticket-a' });
      await connected(client);

      for (const payload of [
        tenantRoom(TENANT_B),
        { room: tenantRoom(TENANT_B) },
        { rooms: [tenantRoom(TENANT_B)] },
        { conversationId: tenantRoom(TENANT_B) },
        { tenantId: TENANT_B },
      ]) {
        client.emit(event, payload);
      }

      // Let anything the server was going to do, happen.
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(roomMembers(tenantRoom(TENANT_B))).toBe(0);
    });

    it('receives nothing addressed to the tenant it asked to join', async () => {
      const client = connect({ ticket: 'ticket-a' });
      await connected(client);

      client.emit('join', tenantRoom(TENANT_B));
      client.emit('conversation.subscribe', { conversationId: CONVERSATION_B });
      await new Promise((resolve) => setTimeout(resolve, 100));

      await relay.onMessageCreated(messageCreated(CONVERSATION_B, TENANT_B));

      expect(await nextEvent(client, 'message.created')).toBeNull();
    });
  });

  describe('conversation.subscribe', () => {
    it('refuses a conversation outside the caller’s tenant', async () => {
      const client = connect({ ticket: 'ticket-a' });
      await connected(client);

      await expect(
        client.emitWithAck('conversation.subscribe', { conversationId: CONVERSATION_B }),
      ).resolves.toEqual({ subscribed: false });
      expect(roomMembers(conversationRoom(CONVERSATION_B))).toBe(0);
    });

    it.each([
      ['a body that is not an object', 'conversation-1'],
      ['a body with no conversation id', {}],
      ['an id that is not an id', { conversationId: 'tenant:' + TENANT_B }],
    ])('refuses %s', async (_case, body) => {
      const client = connect({ ticket: 'ticket-a' });
      await connected(client);

      await expect(client.emitWithAck('conversation.subscribe', body)).resolves.toEqual({
        subscribed: false,
      });
    });

    it('joins a conversation the caller may read', async () => {
      const client = connect({ ticket: 'ticket-a' });
      await connected(client);

      await expect(
        client.emitWithAck('conversation.subscribe', { conversationId: CONVERSATION_A }),
      ).resolves.toEqual({ subscribed: true });
      expect(roomMembers(conversationRoom(CONVERSATION_A))).toBe(1);
    });

    it('leaves on unsubscribe', async () => {
      const client = connect({ ticket: 'ticket-a' });
      await connected(client);

      await client.emitWithAck('conversation.subscribe', { conversationId: CONVERSATION_A });
      await client.emitWithAck('conversation.unsubscribe', { conversationId: CONVERSATION_A });

      expect(roomMembers(conversationRoom(CONVERSATION_A))).toBe(0);
    });
  });

  describe('relayed events', () => {
    it('delivers message.created to a subscribed client as a whole resource', async () => {
      const client = connect({ ticket: 'ticket-a' });
      await connected(client);
      await client.emitWithAck('conversation.subscribe', { conversationId: CONVERSATION_A });

      const received = nextEvent(client, 'message.created', 2_000);
      await relay.onMessageCreated(messageCreated(CONVERSATION_A, TENANT_A));

      expect(await received).toEqual({
        event: 'message.created',
        conversationId: CONVERSATION_A,
        message: PUBLISHED,
      });
    });

    it('delivers a send-status transition to a subscribed client', async () => {
      const client = connect({ ticket: 'ticket-a' });
      await connected(client);
      await client.emitWithAck('conversation.subscribe', { conversationId: CONVERSATION_A });

      const received = nextEvent(client, 'message.status_changed', 2_000);
      await relay.onMessageStatusChanged({
        tenantId: TENANT_A,
        conversationId: CONVERSATION_A,
        messageId: MESSAGE,
        status: 'delivered',
        providerMessageId: 'wamid.abc',
      });

      expect(await received).toMatchObject({
        event: 'message.status_changed',
        messageId: MESSAGE,
        message: PUBLISHED,
      });
    });

    it('never crosses tenants', async () => {
      const a = connect({ ticket: 'ticket-a' });
      const b = connect({ ticket: 'ticket-b' });
      await Promise.all([connected(a), connected(b)]);

      const seenByB = nextEvent(b, 'message.created');
      await relay.onMessageCreated(messageCreated(CONVERSATION_A, TENANT_A));

      expect(await seenByB).toBeNull();
    });
  });

  /**
   * The within-tenant direction, which the cross-tenant test above does not
   * cover and which the review found to be the blocking gap: a fan-out that is
   * wider than `isVisibleOrUnclaimed` hands an agent the body and attachment
   * URLs of a conversation `GET /conversations/{id}` answers `not_found` for.
   */
  describe('a message on a conversation somebody else holds', () => {
    it('does not reach an agent who could not read it over HTTP', async () => {
      audience = { tenantId: TENANT_A, assignedUserId: USER_A, assignedTeamId: null };

      const assignee = connect({ ticket: 'ticket-a' });
      const bystander = connect({ ticket: 'ticket-bystander' });
      await Promise.all([connected(assignee), connected(bystander)]);

      const seenByAssignee = nextEvent(assignee, 'message.created', 2_000);
      const seenByBystander = nextEvent(bystander, 'message.created');
      await relay.onMessageCreated(messageCreated(CONVERSATION_A, TENANT_A));

      // Same tenant, same socket server, same event: the only difference is
      // whether the thread is theirs.
      expect(await seenByAssignee).not.toBeNull();
      expect(await seenByBystander).toBeNull();
    });

    it('still reaches a supervisor, who may read every thread in the tenant', async () => {
      audience = { tenantId: TENANT_A, assignedUserId: USER_A, assignedTeamId: null };

      const supervisor = connect({ ticket: 'ticket-supervisor' });
      await connected(supervisor);

      const received = nextEvent(supervisor, 'message.created', 2_000);
      await relay.onMessageCreated(messageCreated(CONVERSATION_A, TENANT_A));

      expect(await received).not.toBeNull();
    });

    it('reaches every agent while the thread is unclaimed', async () => {
      // The widening TAR-68's amendment 4 rules, and the reason `tenant:{id}`
      // still has a job: a customer wrote in and nobody has claimed them.
      const bystander = connect({ ticket: 'ticket-bystander' });
      await connected(bystander);

      const received = nextEvent(bystander, 'message.created', 2_000);
      await relay.onMessageCreated(messageCreated(CONVERSATION_A, TENANT_A));

      expect(await received).not.toBeNull();
    });

    it('stops reaching a subscriber once somebody else claims it', async () => {
      // Subscribed while unclaimed, which was legitimate at the time. The
      // audience follows the assignment rather than the subscription, so there
      // is no stale membership to clean up.
      const bystander = connect({ ticket: 'ticket-bystander' });
      await connected(bystander);
      await bystander.emitWithAck('conversation.subscribe', { conversationId: CONVERSATION_A });

      audience = { tenantId: TENANT_A, assignedUserId: USER_A, assignedTeamId: null };

      const received = nextEvent(bystander, 'message.created');
      await relay.onMessageCreated(messageCreated(CONVERSATION_A, TENANT_A));

      expect(await received).toBeNull();
    });
  });
});
