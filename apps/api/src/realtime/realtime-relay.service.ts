import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  conversationAudienceRooms,
  tenantCannedResponseRoom,
  userRoom,
  type ConversationResponse,
  type MessageResponse,
  type ServerEvent,
} from '@whatsappcrm/contracts';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  CANNED_RESPONSE_CHANGED_EVENT,
  CONVERSATION_ASSIGNED_EVENT,
  MESSAGE_CREATED_EVENT,
  MESSAGE_STATUS_CHANGED_EVENT,
  SESSIONS_REVOKED_EVENT,
  SLA_BREACHED_EVENT,
  type CannedResponseChangedEvent,
  type ConversationAssignedEvent,
  type MessageCreatedEvent,
  type MessageStatusChangedEvent,
  type SessionsRevokedEvent,
  type SlaBreachedEvent,
} from '../events/domain-events';
import { SessionService } from '../identity/session.service';
import { CannedResponseResourceService } from './canned-response-resource.service';
import { ConversationResourceService } from './conversation-resource.service';
import { MessageResourceService } from './message-resource.service';
import type { RealtimeSocketData } from './realtime-socket';
import { SlaBreachResourceService } from './sla-breach-resource.service';
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
 * `conversation.assigned` from TAR-68's claim endpoint, published as the
 * contract's `conversation.updated` (TAR-198). Without it TAR-20's second
 * acceptance criterion is only half met: the inbox subscribes and would render
 * the new owner immediately, but nothing told it, so a colleague's claim showed
 * up on the next unrelated message or on a reconnect-refetch. See
 * `handoverRooms` below for why this one event is addressed to two audiences
 * rather than one.
 *
 * `canned_response.changed` from TAR-477's CRUD service, published as
 * `canned_response.saved` or `canned_response.deleted` (TAR-485). It is the one
 * relay whose audience is not a conversation's: a canned response is tenant
 * *configuration* that everyone holding `canned_response:read` may read, so it
 * goes to a room derived from that permission rather than to the audience of a
 * thread. See `onCannedResponseChanged`.
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
    private readonly conversations: ConversationResourceService,
    private readonly breaches: SlaBreachResourceService,
    private readonly cannedResponses: CannedResponseResourceService,
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
   * Puts a claim, a release or a hand-over on the wire, to both sides of it.
   *
   * The read is what makes the payload the committed resource rather than the
   * writer's view of it, and — because the audience is derived from the row it
   * returns — it is also what makes the *new* half of the fan-out current. A
   * conversation deleted between the commit and this read relays nothing.
   */
  @OnEvent(CONVERSATION_ASSIGNED_EVENT)
  async onConversationAssigned(event: ConversationAssignedEvent): Promise<void> {
    const server = this.server;

    if (server === null) {
      this.logger.warn(
        `No Socket.IO server attached; dropping an event for conversation ${event.conversationId}.`,
      );
      return;
    }

    try {
      const conversation = await this.tenantContext.run(
        { requestId: randomUUID(), tenantId: event.tenantId, userId: null, principal: null },
        async () => await this.conversations.findForRelay(event.conversationId),
      );

      if (conversation === null) {
        return;
      }

      const payload: ServerEvent = { event: 'conversation.updated', conversation };

      server.to(handoverRooms(event, conversation)).emit(payload.event, payload);
    } catch (error: unknown) {
      this.logger.error(
        `Could not relay conversation ${event.conversationId} to tenant ${event.tenantId}: ${describe(error)}`,
      );
    }
  }

  /**
   * Puts a missed SLA deadline in front of the people who can act on it
   * (TAR-26, 0006 decision 5).
   *
   * **Two events, two audiences, and neither substitutes for the other.**
   *
   *   * `sla.breached` goes to `user:{recipientUserId}` — one emit per
   *     `notifications` row the sweep actually inserted, and to nobody else.
   *     Deliberately not `tenantReadersRoom`: the read rule for an alert is "you
   *     are a named recipient", the rows say who that is, and this file's own
   *     amendment rules that a fan-out wider than the read rule is an
   *     authorization bypass.
   *   * `ticket.updated` goes to `conversationAudienceRooms` read off the
   *     **ticket**, because the ticket's queue row changed too and everybody
   *     entitled to see it should watch the badge move. That function is
   *     structural rather than tied to a row type — its own docblock says so —
   *     and reusing it is what keeps the ticket queue's live audience identical
   *     to the inbox's rule instead of a second one drifting beside it.
   *
   * A supervisor who is both a recipient and in the ticket's audience receives
   * one of each, which is correct: they are different facts.
   *
   * The row is the record and this is the accelerator, so a failure here costs
   * one page load. That is why it is caught and logged like every other relay
   * rather than allowed to reject.
   */
  @OnEvent(SLA_BREACHED_EVENT)
  async onSlaBreached(event: SlaBreachedEvent): Promise<void> {
    const server = this.server;

    if (server === null) {
      this.logger.warn(
        `No Socket.IO server attached; dropping an SLA breach for ticket ${event.ticketId}.`,
      );
      return;
    }

    try {
      const breach = await this.tenantContext.run(
        { requestId: randomUUID(), tenantId: event.tenantId, userId: null, principal: null },
        async () => await this.breaches.findForRelay(event.ticketId, event.alertIds),
      );

      if (breach === null) {
        return;
      }

      for (const delivery of breach.deliveries) {
        const payload: ServerEvent = {
          event: 'sla.breached',
          alert: delivery.alert,
          ticket: breach.ticket,
        };

        server.to(userRoom(delivery.recipientUserId)).emit(payload.event, payload);
      }

      const updated: ServerEvent = { event: 'ticket.updated', ticket: breach.ticket };

      server
        .to(
          conversationAudienceRooms({
            tenantId: event.tenantId,
            assignedUserId: breach.ticket.assignedUserId,
            assignedTeamId: breach.ticket.assignedTeamId,
          }),
        )
        .emit(updated.event, updated);
    } catch (error: unknown) {
      this.logger.error(
        `Could not relay the SLA breach on ticket ${event.ticketId} to tenant ${event.tenantId}: ${describe(error)}`,
      );
    }
  }

  /**
   * Puts an edit to the tenant's canned-response library in front of every agent
   * on it (TAR-31's second acceptance criterion, TAR-485).
   *
   * **The audience is a permission, not a tenant.** `tenantCannedResponseRoom`
   * holds the sockets whose principal carried `canned_response:read` at the
   * handshake — the same rule `GET /canned-responses` enforces, expressed as a
   * room. Every role holds that permission today, so the room currently contains
   * what `tenantRoom` does; addressing `tenantRoom` instead would make this file
   * depend on that staying true, and a fan-out wider than the read rule is an
   * authorization bypass rather than an untidiness.
   *
   * **A save reads the row back; a delete cannot and does not.** The read is
   * what makes the payload the committed row rather than the writer's view of
   * it, and it runs in a scope opened from the event's own tenant id, so an id
   * that named another tenant's row publishes nothing. A `saved` whose row is
   * already gone — a delete landed in between — publishes nothing either, and
   * the `deleted` event that delete emitted is what makes the console converge.
   *
   * A delete has nothing to read, so it skips the query and publishes the id
   * alone. That is also why this handler cannot leak on the race: the id is not
   * a resource, and the room it goes to is derived from the subscriber's own
   * permission.
   */
  @OnEvent(CANNED_RESPONSE_CHANGED_EVENT)
  async onCannedResponseChanged(event: CannedResponseChangedEvent): Promise<void> {
    const server = this.server;

    if (server === null) {
      this.logger.warn(
        `No Socket.IO server attached; dropping an event for canned response ${event.cannedResponseId}.`,
      );
      return;
    }

    try {
      const payload = await this.cannedResponsePayload(event);

      if (payload === null) {
        return;
      }

      server.to(tenantCannedResponseRoom(event.tenantId)).emit(payload.event, payload);
    } catch (error: unknown) {
      this.logger.error(
        `Could not relay canned response ${event.cannedResponseId} to tenant ${event.tenantId}: ${describe(error)}`,
      );
    }
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
   * What a canned-response change puts on the wire, or `null` when there is
   * nothing to say.
   *
   * Split out so the two branches of `change` read as the two shapes they are —
   * a whole resource that has to be fetched, and a terminal id that must not be.
   */
  private async cannedResponsePayload(
    event: CannedResponseChangedEvent,
  ): Promise<ServerEvent | null> {
    if (event.change === 'deleted') {
      return { event: 'canned_response.deleted', cannedResponseId: event.cannedResponseId };
    }

    const cannedResponse = await this.tenantContext.run(
      { requestId: randomUUID(), tenantId: event.tenantId, userId: null, principal: null },
      async () => await this.cannedResponses.findForRelay(event.cannedResponseId),
    );

    return cannedResponse === null ? null : { event: 'canned_response.saved', cannedResponse };
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

/**
 * The rooms a hand-over is addressed to: the audience the thread **had**, union
 * the audience it **has**.
 *
 * Every other relay addresses one audience, because a message only ever concerns
 * the people who can see the thread now. A hand-over is the one event whose whole
 * point is that the answer changed, and addressing only the new audience would
 * deliver it to everybody except the colleagues it is news for — the agents who
 * were looking at an unclaimed thread, and the agent who has just lost one. That
 * is precisely the gap this exists to close, so the previous audience is not an
 * optimisation here, it is the requirement.
 *
 * Each half is `conversationAudienceRooms` — the contract's own published rule,
 * not a second description of it — so the union is exactly the set of principals
 * `isVisibleOrUnclaimed` admitted before the write or admits after it, and nobody
 * else. Worked through:
 *
 * ```
 *   unclaimed → agent A   readers + tenant + user:A   every agent learns it is gone
 *   agent A   → agent B   readers + user:A + user:B   a third agent never had it
 *   agent A   → unclaimed readers + user:A + tenant   back in front of everybody
 * ```
 *
 * The middle row is why this is not simply "emit to `tenant:{id}`": a thread
 * moving between two agents is not news the rest of the tenant is entitled to,
 * and the payload is the whole resource — the customer, the preview, the unread
 * count.
 *
 * The other half of that trade is stated rather than glossed: the agent who just
 * lost the thread receives one final copy of it. That is the minimum a client
 * needs to be *told* it is gone rather than to discover it, it names a principal
 * who could read the same resource a moment earlier, and the alternative — a
 * dedicated "you lost this" wire event — is a contract amendment this does not
 * need. Nothing after this emit reaches them: the next message on the thread is
 * addressed to the new audience alone.
 *
 * `conversationRoom` is absent, as it is everywhere in this file, and here it
 * would also be redundant: a socket may only join it if it was in the audience at
 * the time, and room membership follows the principal, so every subscriber is
 * already in the first half of this union.
 *
 * De-duplicated because the two halves overlap in the common case — the readers
 * room is in both, always. `to()` unions rooms and Socket.IO de-duplicates a
 * socket across them, so this is about the room list being readable in a log
 * rather than about anybody receiving two copies.
 */
function handoverRooms(
  event: ConversationAssignedEvent,
  conversation: ConversationResponse,
): string[] {
  return [
    ...new Set([
      ...conversationAudienceRooms({
        tenantId: event.tenantId,
        assignedUserId: event.previousAssignedUserId,
        assignedTeamId: event.previousAssignedTeamId,
      }),
      // From the row that was read back, never from the event: the assignment
      // that decides who may see this payload has to be the committed one.
      ...conversationAudienceRooms({
        tenantId: event.tenantId,
        assignedUserId: conversation.assignedUserId,
        assignedTeamId: conversation.assignedTeamId,
      }),
    ]),
  ];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
