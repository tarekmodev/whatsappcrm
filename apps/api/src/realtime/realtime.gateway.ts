import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import {
  IdSchema,
  conversationRoom,
  teamRoom,
  tenantCannedResponseRoom,
  tenantReadersRoom,
  tenantRoom,
  userRoom,
} from '@whatsappcrm/contracts';
import type { Server } from 'socket.io';
import { z } from 'zod';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { ConversationAccessService } from './conversation-access.service';
import { REALTIME_PATH } from './realtime.constants';
import { RealtimeHandshakeService } from './realtime-handshake.service';
import { RealtimeRelayService } from './realtime-relay.service';
import { principalOf, type RealtimeSocket } from './realtime-socket';

/**
 * The Socket.IO gateway (TAR-39, `RealtimeModule`), and the one place a socket
 * is put into a room.
 *
 * ## Rooms are joined from the server's view, never from a name a client sent
 *
 * There is no `join` event and there never will be. A socket's tenant and user
 * rooms are derived from the principal the handshake resolved, and the only
 * client-supplied identifier the gateway accepts anywhere is a **conversation
 * id** — which `ConversationAccessService` authorises before the join. A client
 * that emits `conversation.subscribe` with another tenant's id is refused by
 * row-level security without the gateway comparing anything, and one that
 * invents a room name has nothing to send it to.
 *
 * ## Authentication is middleware, not a connection handler
 *
 * `afterInit` installs it on the server rather than doing the work in
 * `handleConnection`, and the difference is a real race rather than a style
 * preference: Socket.IO fires `connection` immediately and delivers events as
 * they arrive, so an `async` connection handler leaves a window in which a
 * `conversation.subscribe` can reach a handler before the principal is attached.
 * A middleware runs *before* the connection exists, so there is no window.
 * (`principalOf` still refuses an unauthenticated socket — fail closed at both
 * ends, on `PrincipalGuard`'s reasoning.)
 *
 * ## Everything a handler does runs in a tenant scope
 *
 * Opened per event from `socket.data.principal`, because `AsyncLocalStorage` is
 * per async execution and a socket outlives every one of them. Without it a
 * handler's first query would throw `MissingTenantContextError` rather than read
 * the wrong tenant — the data layer fails closed — but throwing on every
 * subscribe is not a working gateway.
 */
@WebSocketGateway({
  path: REALTIME_PATH,
  // Only the two transports Socket.IO ships. Named rather than defaulted so a
  // deployment behind a proxy that cannot upgrade still connects by polling
  // instead of failing in a way that looks like an auth problem.
  transports: ['websocket', 'polling'],
  // CORS is set here to *nothing* on purpose: `RealtimeIoAdapter` supplies it
  // from `WEB_ORIGIN` at boot. A decorator is evaluated at class-definition
  // time, long before `ConfigService` exists, so an origin written here would
  // be a literal that cannot follow the environment.
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly handshake: RealtimeHandshakeService,
    private readonly conversations: ConversationAccessService,
    private readonly relay: RealtimeRelayService,
    private readonly tenantContext: TenantContextService,
  ) {}

  afterInit(server: Server): void {
    this.relay.attach(server);

    server.use((socket, next) => {
      void this.handshake
        .authenticate(socket.handshake.auth)
        .then((authenticated) => {
          if (authenticated === null) {
            // One message for every refusal. Distinguishing an expired ticket
            // from a revoked session would tell the holder of a random string
            // something about the state of an account.
            next(new Error('unauthorized'));
            return;
          }

          (socket as unknown as RealtimeSocket).data = authenticated;
          next();
        })
        .catch((error: unknown) => {
          this.logger.error(`Realtime handshake failed: ${describe(error)}`);
          next(new Error('unauthorized'));
        });
    });
  }

  handleConnection(socket: RealtimeSocket): void {
    const principal = principalOf(socket);

    if (principal === null) {
      // Unreachable while the middleware above is installed, and a disconnect
      // rather than a throw if it ever is not: a socket with no principal has
      // no room it may legitimately be in.
      socket.disconnect(true);
      return;
    }

    // One room per branch of `isVisibleOrUnclaimed`, all of them derived from
    // the resolved principal. A publisher then addresses the branches that match
    // the conversation's current assignment, so the audience of an event is the
    // set of principals the REST API would show that thread to — no wider.
    void socket.join(tenantRoom(principal.tenantId));
    void socket.join(userRoom(principal.userId));

    for (const teamId of principal.teamIds) {
      void socket.join(teamRoom(teamId));
    }

    if (principal.permissions.includes(CONVERSATION_READ_ALL)) {
      void socket.join(tenantReadersRoom(principal.tenantId));
    }

    // The canned-response library is tenant configuration rather than an
    // assignable record, so its audience is a permission rather than a branch of
    // `isVisibleOrUnclaimed` — same guard, same shape, read off the same
    // resolved principal (TAR-485).
    if (principal.permissions.includes(CANNED_RESPONSE_READ)) {
      void socket.join(tenantCannedResponseRoom(principal.tenantId));
    }

    this.logger.log(
      `Socket ${socket.id} joined tenant ${principal.tenantId} as user ${principal.userId} ` +
        `(request ${socket.data.requestId}).`,
    );
  }

  /**
   * Joins `conversation:{id}` once the caller is shown to be allowed in.
   *
   * The acknowledgement is deliberately boolean-shaped and uniform. A client
   * that is refused learns only that it was — "no such conversation", "another
   * tenant's" and "not assigned to you" are one answer, because three would make
   * this an oracle for which conversation ids exist.
   */
  @SubscribeMessage('conversation.subscribe')
  async subscribe(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<SubscriptionAck> {
    const principal = principalOf(socket);
    const payload = ConversationSubscriptionSchema.safeParse(body);

    if (principal === null || !payload.success) {
      return { subscribed: false };
    }

    const { conversationId } = payload.data;

    const allowed = await this.tenantContext.run(
      {
        requestId: socket.data.requestId,
        tenantId: principal.tenantId,
        userId: principal.userId,
        principal,
      },
      async () => await this.conversations.maySubscribe(principal, conversationId),
    );

    if (!allowed) {
      return { subscribed: false };
    }

    await socket.join(conversationRoom(conversationId));

    return { subscribed: true };
  }

  /**
   * Leaves a conversation room.
   *
   * Unauthorised deliberately: leaving a room a socket is not in is a no-op, and
   * there is nothing to protect on the way out. Refusing it would only leave a
   * client subscribed to a thread it has navigated away from.
   */
  @SubscribeMessage('conversation.unsubscribe')
  async unsubscribe(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<SubscriptionAck> {
    const payload = ConversationSubscriptionSchema.safeParse(body);

    if (!payload.success) {
      return { subscribed: false };
    }

    await socket.leave(conversationRoom(payload.data.conversationId));

    return { subscribed: false };
  }
}

/**
 * The body of `conversation.subscribe` and `conversation.unsubscribe`.
 *
 * `ClientEventSchema` in the contract carries an `event` discriminant as well;
 * on Socket.IO that discriminant *is* the event name, which the transport
 * already delivers separately, so requiring it in the body too would make every
 * client send the same string twice. What is left is the conversation id, and it
 * is validated rather than read — this is the one identifier in the whole
 * gateway that comes from a client.
 */
const ConversationSubscriptionSchema = z.object({ conversationId: IdSchema });

/**
 * The permission that decides whether a socket joins the tenant-wide readers
 * room. Named here rather than written inline so it greps alongside every other
 * use of the same string.
 */
const CONVERSATION_READ_ALL = 'conversation:read_all';

/**
 * The permission that decides whether a socket joins the tenant's
 * canned-response room, named here for the same reason the one above is.
 *
 * Every role holds it today, so the room and `tenantRoom` currently contain the
 * same sockets. Joining on the permission anyway is what keeps the fan-out equal
 * to the read rule if that stops being true (0011 decision 2).
 */
const CANNED_RESPONSE_READ = 'canned_response:read';

/**
 * What a subscribe or unsubscribe acknowledges: whether the socket is now in the
 * room. Gateway-local, and not part of `ServerEventSchema` — that union is the
 * server's *events*, and an ack is a reply to a call the client made.
 */
export interface SubscriptionAck {
  readonly subscribed: boolean;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
