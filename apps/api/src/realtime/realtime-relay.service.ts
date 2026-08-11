import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  conversationAudienceRooms,
  userRoom,
  type MessageResponse,
  type ServerEvent,
} from '@whatsappcrm/contracts';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  MESSAGE_CREATED_EVENT,
  MESSAGE_STATUS_CHANGED_EVENT,
  SESSIONS_REVOKED_EVENT,
  type MessageCreatedEvent,
  type MessageStatusChangedEvent,
  type SessionsRevokedEvent,
} from '../events/domain-events';
import { SessionService } from '../identity/session.service';
import { MessageResourceService } from './message-resource.service';
import type { RealtimeSocketData } from './realtime-socket';
import { TenantHostnameService } from './tenant-hostname.service';

/**
 * The bridge from the in-process domain bus to the rooms (TAR-39: the realtime
 * relay is `EventEmitterModule`'s first consumer).
 *
 * ## What it relays, and what it does not
 *
 * `message.created` from TAR-20b's ingestion pipeline, and the send-status
 * ladder — `queued → sent → delivered → read`, or `failed` — from that same
 * writer and from TAR-68's send path and delivery worker. Both arrive as the
 * *same* two domain events regardless of which side produced them, which is why
 * this file has two subscribers rather than one per producer, and why a send
 * that Meta refuses reaches the agent's screen on the same path a customer's
 * message does.
 *
 * `message.attachment_settled` and `ticket.created` are emitted today and
 * deliberately not relayed here: neither has a server event in TAR-39's fixed
 * realtime contract, and inventing a wire event for them is a contract
 * amendment rather than something a gateway may decide on its own. Recorded as
 * a gap rather than silently half-implemented — an inbound picture's spinner
 * stops on the next refetch, not on an event.
 *
 * ## Every relay opens its own tenant scope
 *
 * The emitter's scope is not borrowed. `EventEmitter2` dispatches on the
 * caller's stack, so today the ambient tenant *would* be the right one — but
 * that is a property of the emitter's call site, not of this file, and a
 * producer that ever emits from a timer or after an `await` at the wrong depth
 * would make this read another tenant's row. The scope is re-established from
 * the event's own `tenantId`, exactly as a queue worker re-establishes one from
 * its payload.
 *
 * ## Nothing here may throw
 *
 * `@OnEvent` handlers are dispatched without an `await`, so a rejection is an
 * unhandled promise rather than a caller's problem. A failure to relay costs a
 * client one refetch — the row is already committed — so every path is caught
 * and logged rather than left to take the process down.
 *
 * ## The isolation boundary is the room set, and it matches the read rule
 *
 * `conversationAudienceRooms` turns the conversation's **current** assignment
 * into exactly the rooms `isVisibleOrUnclaimed` would admit: the tenant's
 * `conversation:read_all` holders always, the assignee or the routed team when
 * there is one, and every agent in the tenant only while the thread is
 * unclaimed. Every id in that set comes from the row this relay just read, never
 * from anything a client asked for.
 *
 * Deriving it per emit rather than joining it once is what keeps it honest.
 * The first published shape sent every message to `tenant:{id}` — every socket
 * in the tenant — which handed an agent the body and attachment URLs of threads
 * `GET /conversations/{id}` answers `not_found` for. Amending the contract was
 * the right fix rather than a local workaround, because the fan-out was
 * published that way; see `packages/contracts/src/realtime.ts` and 0002's
 * amendment 5.
 *
 * The conversation room is deliberately **not** in the set. A subscription was
 * authorised at the moment it was made, and a thread claimed since would keep
 * publishing to whoever happened to be watching — the audience has to follow the
 * assignment, not the other way round.
 */
@Injectable()
export class RealtimeRelayService {
  private readonly logger = new Logger(RealtimeRelayService.name);
  private server: Server | null = null;

  constructor(
    private readonly messages: MessageResourceService,
    private readonly hostnames: TenantHostnameService,
    private readonly sessions: SessionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Publishes the Socket.IO server once the gateway has one.
   *
   * The relay is a plain provider rather than part of the gateway class so that
   * "what goes on the wire" is testable without a socket server, and so the
   * gateway stays about connections. It holds the server rather than injecting
   * it because Nest creates the server during `afterInit`, after every provider
   * has been constructed.
   */
  attach(server: Server): void {
    this.server = server;
  }

  @OnEvent(MESSAGE_CREATED_EVENT)
  async onMessageCreated(event: MessageCreatedEvent): Promise<void> {
    await this.relayMessage(event.tenantId, event.messageId, (message) => ({
      event: 'message.created',
      conversationId: event.conversationId,
      message,
    }));
  }

  @OnEvent(MESSAGE_STATUS_CHANGED_EVENT)
  async onMessageStatusChanged(event: MessageStatusChangedEvent): Promise<void> {
    await this.relayMessage(event.tenantId, event.messageId, (message) => ({
      event: 'message.status_changed',
      conversationId: event.conversationId,
      messageId: event.messageId,
      message,
    }));
  }

  /**
   * Drops the sockets of a user whose sessions may just have died.
   *
   * The gap this closes: authentication happens once, at the handshake, and a
   * WebSocket has no next request to be refused on. Without this an agent an
   * admin suspended keeps an open socket until the tab closes — bounded only by
   * the 30-day absolute session cap — which contradicts what
   * `SessionRevocationService` states it is for.
   *
   * Each socket is judged on its **own** session rather than on the event,
   * because the producer fires on any revocation path including ones that
   * revoked nothing (see `SessionsRevokedEvent`), and because one user's
   * sessions do not all die together: a signed-in password change spares the tab
   * doing the typing, and `DELETE /auth/sessions/{id}` kills exactly one device.
   * Re-reading is what tells those apart. `resolveBySessionId` answers `null`
   * for revoked, expired and suspended alike, which is precisely the set that
   * should lose its socket.
   *
   * `session.revoked` goes to the socket before it is closed, so a client can
   * show "you were signed out" rather than treat it as a dropped connection and
   * reconnect into a refused handshake. It is emitted to the socket rather than
   * to `user:{id}` wholesale: the other tabs of a user whose *other* device was
   * signed out are still live, and telling them all to log out would turn one
   * device removal into a full sign-out.
   *
   * Cluster-wide: `fetchSockets()` goes through the Redis adapter, so a
   * revocation on the replica that served the HTTP request reaches a socket held
   * by any other.
   */
  @OnEvent(SESSIONS_REVOKED_EVENT)
  async onSessionsRevoked(event: SessionsRevokedEvent): Promise<void> {
    const server = this.server;

    if (server === null) {
      return;
    }

    try {
      const sockets = await server.in(userRoom(event.userId)).fetchSockets();

      if (sockets.length === 0) {
        return;
      }

      await this.tenantContext.run(
        {
          requestId: randomUUID(),
          tenantId: event.tenantId,
          userId: event.userId,
          principal: null,
        },
        async () => {
          for (const socket of sockets) {
            const data = socket.data as Partial<RealtimeSocketData>;
            const sessionId = data.principal?.sessionId;

            // A socket in this room with no principal cannot have got past the
            // handshake middleware; close it rather than reason about it.
            if (sessionId === undefined) {
              socket.disconnect(true);
              continue;
            }

            if ((await this.sessions.resolveBySessionId(sessionId)) !== null) {
              continue;
            }

            const revoked: ServerEvent = { event: 'session.revoked', sessionId };

            socket.emit(revoked.event, revoked);
            socket.disconnect(true);
          }
        },
      );
    } catch (error: unknown) {
      this.logger.error(`Could not re-check sockets for user ${event.userId}: ${describe(error)}`);
    }
  }

  /**
   * Reads the message back as a full resource and puts it on the wire.
   *
   * The read happens even when no socket is listening. It could be skipped by
   * asking the adapter whether the rooms are empty first, but under the Redis
   * adapter that is itself a round trip to answer a question about *other*
   * replicas — so the saving is illusory in exactly the deployment where it
   * would matter.
   */
  private async relayMessage(
    tenantId: string,
    messageId: string,
    toEvent: (message: MessageResponse) => ServerEvent,
  ): Promise<void> {
    const server = this.server;

    if (server === null) {
      // The gateway has not initialised, which on a running process means the
      // module was left out of the graph. Worth a line: it is the difference
      // between "no clients connected" and "the relay is not wired at all".
      this.logger.warn(`No Socket.IO server attached; dropping an event for message ${messageId}.`);
      return;
    }

    try {
      const relayable = await this.tenantContext.run(
        { requestId: randomUUID(), tenantId, userId: null, principal: null },
        async () =>
          // The hostname first: a relayed payload can carry an absolute
          // attachment URL, and `ResponseOriginService` refuses to invent an
          // origin for a scope no request opened. Establishing it here, beside
          // the tenant, is the same thing a queue worker does with its payload.
          (await this.hostnames.publish()) ? await this.messages.findForRelay(messageId) : null,
      );

      if (relayable === null) {
        return;
      }

      const payload = toEvent(relayable.message);
      const rooms = conversationAudienceRooms(relayable.audience);

      // `to()` unions rooms and Socket.IO de-duplicates a socket in more than
      // one of them, so a supervisor who is also the assignee receives one copy.
      server.to(rooms).emit(payload.event, payload);
    } catch (error: unknown) {
      this.logger.error(`Could not relay ${messageId} to tenant ${tenantId}: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
