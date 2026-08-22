import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MESSAGE_CREATED_EVENT, type MessageCreatedEvent } from '../events/domain-events';
import type { Prisma } from '../generated/prisma/client';
import {
  MessageContentType,
  MessageDirection,
  MessageOrigin,
  MessageStatus,
} from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { QueueService } from '../queue/queue.service';
import {
  CONVERSATIONS_QUEUE,
  SEND_MAX_ATTEMPTS,
  SEND_OUTBOUND_MESSAGE_JOB,
  SEND_RETRY_BACKOFF_MS,
  sendOutboundMessageJobId,
} from './conversations.constants';
import type { SendOutboundMessageJob } from './outbound-message.jobs';

/**
 * An outbound text message nobody typed — the AI chatbot's reply (TAR-28), and
 * whatever TAR-27's workflow send action needs next.
 *
 * ## Why this is here rather than in the module that calls it
 *
 * The send path belongs to `ConversationsModule`: the `messages` row, the
 * forward-only `last_message_at` write, the delivery job and the realtime event
 * are one shape, and a second module reproducing it would be a second place the
 * inbox's invariants live. `AiModule` is L4 and may import this module, so what
 * crosses the line is a provider rather than a copy of `MessageSendService`'s
 * transaction.
 *
 * ## Why it is not `MessageSendService`
 *
 * That service answers an agent's composer, and every line of it assumes one:
 * it requires a principal, it refuses a thread nobody has claimed, and it stamps
 * `sender_user_id`. An automated send has no principal, must work on an
 * unclaimed thread — which is the ordinary state of a conversation a bot is
 * answering — and must record a null sender. Adding an `actor?: null` branch to
 * that service would put "is there a human here" inside every one of those
 * rules; a second, much smaller entry point keeps the agent path exactly as
 * strict as it is today.
 *
 * ## What it deliberately does not do
 *
 * No opt-out check, no service-window check, no template support. The caller
 * decides whether an automated message is appropriate — `BotEligibilityService`
 * makes exactly those checks with the extra context a bot turn has — and this
 * class does not silently make a policy decision on its behalf. Text only:
 * automation that needs to send media is a different feature with a different
 * resolution step.
 */
@Injectable()
export class AutomatedMessageSender {
  private readonly logger = new Logger(AutomatedMessageSender.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly queue: QueueService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Writes the message and hands the delivery to the worker, exactly as an
   * agent's send does — the row is committed `queued` and the Cloud API call
   * happens off the request.
   *
   * Returns the committed message id, because the caller records it: a bot turn
   * stores `reply_message_id`, which is what links a score to the words the
   * customer actually received.
   *
   * The transaction is passed in rather than opened here, and that is
   * load-bearing for the bot: the reply and the `bot_turns` row that makes a
   * second reply impossible have to commit together, or a crash between them
   * costs the customer a duplicate message.
   */
  async writeOutboundText(
    tx: Prisma.TransactionClient,
    input: AutomatedMessageInput,
  ): Promise<string> {
    const { id } = await tx.message.create({
      data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        direction: MessageDirection.outbound,
        status: MessageStatus.queued,
        contentType: MessageContentType.text,
        body: input.body,
        // Null sender *and* an explicit origin. The null is what `sentByAutomation`
        // has always been derived from; the origin is what lets the console tell a
        // bot reply from a workflow reply or a delivery placeholder (0010
        // decision 14), and naming it here is what stops the `messages_derive_origin`
        // trigger completing this row as `system`.
        senderUserId: null,
        origin: input.origin,
        // Our clock: Meta has not seen this message yet. The status webhook that
        // follows carries Meta's own timestamp for the delivery steps.
        sentAt: input.sentAt,
      },
      select: { id: true },
    });

    // Forward-only, in the `WHERE` clause, exactly as the agent send and the
    // ingest writer do it: an inbound message that arrives while this
    // transaction is open must not be overwritten by an older outbound
    // timestamp. The service window is deliberately untouched — only the
    // customer writing to us opens one.
    await tx.conversation.updateMany({
      where: { id: input.conversationId, lastMessageAt: { lt: input.sentAt } },
      data: { lastMessageAt: input.sentAt },
    });

    return id;
  }

  /**
   * The two things that must happen **after** the caller's transaction commits:
   * the delivery job, and the realtime push.
   *
   * Separate from the write for the reason every other producer in this codebase
   * separates them — a job that reached a worker before the row committed would
   * read nothing and burn a retry, and pushing a message to an agent's screen
   * that a rollback then un-wrote is worse than pushing it a moment later.
   *
   * Never throws. The row is committed and says `queued`, so a Redis blip costs
   * a reply that has not gone out yet rather than a turn that fails after the
   * message was already recorded.
   */
  async dispatch(sent: DispatchedMessage): Promise<void> {
    const outcome = await this.queue.enqueue<SendOutboundMessageJob>(
      CONVERSATIONS_QUEUE,
      SEND_OUTBOUND_MESSAGE_JOB,
      { tenantId: sent.tenantId, messageId: sent.messageId },
      {
        jobId: sendOutboundMessageJobId(sent.messageId),
        attempts: SEND_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: SEND_RETRY_BACKOFF_MS },
        removeOnComplete: true,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Automated message ${sent.messageId} was recorded but not queued for delivery (${outcome}); it will stay queued.`,
      );
    }

    const event: MessageCreatedEvent = {
      tenantId: sent.tenantId,
      conversationId: sent.conversationId,
      contactId: sent.contactId,
      messageId: sent.messageId,
      direction: MessageDirection.outbound,
      status: MessageStatus.queued,
      contentType: MessageContentType.text,
      body: sent.body,
      providerMessageId: null,
      sentAt: sent.sentAt,
    };

    this.events.emit(MESSAGE_CREATED_EVENT, event);
  }
}

export interface AutomatedMessageInput {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly body: string;
  readonly origin: MessageOrigin;
  readonly sentAt: Date;
}

export interface DispatchedMessage {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly contactId: string;
  readonly messageId: string;
  readonly body: string;
  readonly sentAt: Date;
}
