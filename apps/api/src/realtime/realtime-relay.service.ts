import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  conversationRoom,
  tenantRoom,
  type MessageResponse,
  type ServerEvent,
} from '@whatsappcrm/contracts';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  MESSAGE_CREATED_EVENT,
  MESSAGE_STATUS_CHANGED_EVENT,
  type MessageCreatedEvent,
  type MessageStatusChangedEvent,
} from '../events/domain-events';
import { MessageResourceService } from './message-resource.service';

/**
 * The bridge from the in-process domain bus to the rooms (TAR-39: the realtime
 * relay is `EventEmitterModule`'s first consumer).
 *
 * ## What it relays, and what it does not
 *
 * `message.created` from TAR-20b's ingestion pipeline, and the send-status
 * ladder — `queued → sent → delivered → read`, or `failed` — from the same
 * writer and, once it exists, from TAR-20c's send path. Both arrive as the
 * *same* two domain events regardless of which side produced them, which is why
 * this file has two subscribers rather than one per producer.
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
 * ## The isolation boundary, and a limit inside it
 *
 * Rooms are the boundary: a payload goes to `tenant:{id}` and to
 * `conversation:{id}`, both derived from the event's own ids, never from
 * anything a client asked for. Socket.IO de-duplicates a socket that is in both,
 * so a client receives one copy.
 *
 * ⚠️ The tenant room is every socket in the tenant, so a tenant-wide fan-out of
 * message content reaches agents who could not read that conversation over HTTP
 * — TAR-22's `isVisible` scopes an agent to their own and their teams' threads,
 * and a room cannot express that. TAR-39 fixes both the room vocabulary and the
 * fan-out, so this implements what the contract says and records the gap rather
 * than inventing a `team:{id}` room that TAR-20f and TAR-20g are not built
 * against. Closing it needs a contract amendment: either scope the fan-out to
 * `user:{assignedUserId}` plus a team room, or restrict the tenant room to
 * holders of `conversation:read_all`.
 */
@Injectable()
export class RealtimeRelayService {
  private readonly logger = new Logger(RealtimeRelayService.name);
  private server: Server | null = null;

  constructor(
    private readonly messages: MessageResourceService,
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
    await this.relayMessage(event.tenantId, event.conversationId, event.messageId, (message) => ({
      event: 'message.created',
      conversationId: event.conversationId,
      message,
    }));
  }

  @OnEvent(MESSAGE_STATUS_CHANGED_EVENT)
  async onMessageStatusChanged(event: MessageStatusChangedEvent): Promise<void> {
    await this.relayMessage(event.tenantId, event.conversationId, event.messageId, (message) => ({
      event: 'message.status_changed',
      conversationId: event.conversationId,
      messageId: event.messageId,
      message,
    }));
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
    conversationId: string,
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
      const message = await this.tenantContext.run(
        { requestId: randomUUID(), tenantId, userId: null, principal: null },
        async () => await this.messages.findForRelay(messageId),
      );

      if (message === null) {
        return;
      }

      const payload = toEvent(message);

      server
        .to(tenantRoom(tenantId))
        .to(conversationRoom(conversationId))
        .emit(payload.event, payload);
    } catch (error: unknown) {
      this.logger.error(`Could not relay ${messageId} to tenant ${tenantId}: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
