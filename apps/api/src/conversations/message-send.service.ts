import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  SLA_EVALUATE_TICKET_JOB,
  SLA_QUEUE,
  TICKET_ACTIVE_STATUSES,
  mediaContentPath,
  slaEvaluateJobId,
  type MessageResponse,
  type SendMediaInput,
  type SendMessageInput,
  type SendTemplateInput,
  type SlaEvaluateTicketTrigger,
} from '@whatsappcrm/contracts';
import { ResponseOriginService } from '../common/response-origin.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { MESSAGE_CREATED_EVENT, type MessageCreatedEvent } from '../events/domain-events';
import type { Prisma } from '../generated/prisma/client';
import {
  MediaDownloadState,
  MessageContentType,
  MessageDirection,
  MessageStatus,
  type MediaKind,
} from '../generated/prisma/enums';
import { MediaSendResolver } from '../media/media-send.resolver';
import type { MediaObjectRecord } from '../media/media-reader.service';
import { MediaNotFoundError } from '../media/media.errors';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { QueueService } from '../queue/queue.service';
import { MessageTemplateQueryService } from '../whatsapp/message-template-query.service';
import { ConversationQueryService } from './conversation-query.service';
import {
  CONVERSATIONS_QUEUE,
  SEND_MAX_ATTEMPTS,
  SEND_OUTBOUND_MESSAGE_JOB,
  SEND_RETRY_BACKOFF_MS,
  sendOutboundMessageJobId,
} from './conversations.constants';
import {
  ContactOptedOutError,
  SendMediaNotUsableError,
  ServiceWindowExpiredError,
  TemplateNotSendableError,
} from './conversations.errors';
import { MESSAGE_PROJECTION, toMessageResponse, type MessageRow } from './message.mapper';
import type { OutboundTemplate, SendOutboundMessageJob } from './outbound-message.jobs';
import { isServiceWindowOpen } from './service-window';
import {
  assertTemplateSendable,
  isMediaHeader,
  renderTemplateBody,
} from './template-send.validator';

/**
 * `POST /api/v1/conversations/{id}/messages` — an agent's reply.
 *
 * ## The row is created, and the send is queued
 *
 * The endpoint answers with a `queued` message and returns; a worker performs
 * the Cloud API call. That ordering is the design, not an optimisation:
 *
 *   * an agent's composer must not sit on a Meta call that can take seconds or
 *     be throttled for minutes;
 *   * the committed row is what makes a retry safe — it is the durable record
 *     that this message is owed, so a crash between the transaction and the
 *     enqueue costs a delivery that a sweep can find, not a message nobody has
 *     any trace of;
 *   * status transitions reach the agent's screen over TAR-20d's socket, which
 *     is where `queued → sent → delivered → read` is meant to be watched.
 *
 * The enqueue happens **after** the commit, per `QueueService`'s contract, and
 * never fails the request: if Redis is down the message stays `queued` and says
 * so. The honest limitation, recorded rather than glossed: nothing re-queues it
 * today. A sweep over outbound messages left `queued` past a threshold — failing
 * them, so the agent sees "not sent" — is this story's stated follow-up.
 *
 * ## Every refusal happens before the row exists
 *
 * Visibility, who holds the thread, opt-out, the service window, the template's
 * approval and arity, the media's kind: all of them are checked first, so a
 * refused send leaves nothing behind and the agent is told what to change while
 * the composer is still open. Nothing here writes and then decides.
 *
 * ## Isolation
 *
 * `TenantPrisma` throughout, so RLS supplies `tenant_id`. The conversation is
 * loaded through `ConversationQueryService.requireHeld`, which is the same
 * visibility check every other route in this module uses plus the one a write
 * adds — a thread this principal may not see answers `not_found` rather than
 * sending to it, and one nobody has claimed answers `conflict` until they do.
 */
@Injectable()
export class MessageSendService {
  private readonly logger = new Logger(MessageSendService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly conversations: ConversationQueryService,
    private readonly templates: MessageTemplateQueryService,
    private readonly media: MediaSendResolver,
    private readonly queue: QueueService,
    private readonly events: EventEmitter2,
    private readonly origin: ResponseOriginService,
  ) {}

  async send(conversationId: string, input: SendMessageInput): Promise<MessageResponse> {
    const principal = this.tenantContext.requirePrincipal();
    const conversation = await this.loadSendTarget(conversationId);

    if (conversation.contact.optedOutAt !== null) {
      throw new ContactOptedOutError();
    }

    const draft = await this.prepare(conversation, input);

    const created = await this.prisma.$tenantTransaction(async (tx) => {
      const { id } = await tx.message.create({
        data: {
          tenantId: principal.tenantId,
          conversationId,
          direction: MessageDirection.outbound,
          status: MessageStatus.queued,
          contentType: draft.contentType,
          body: draft.body,
          senderUserId: principal.userId,
          // Our clock, because Meta has not seen this message yet. The status
          // webhook that follows carries Meta's own timestamp for the delivery
          // steps; `sent_at` stays the moment the agent pressed send, which is
          // what the thread orders by and what an SLA measures against.
          sentAt: draft.sentAt,
        },
        select: { id: true },
      });

      if (draft.attachment !== null) {
        await tx.messageAttachment.create({
          data: { tenantId: principal.tenantId, messageId: id, ...draft.attachment },
          select: { id: true },
        });
      }

      // Forward-only, in the `WHERE` clause, exactly as the ingest writer does
      // it: an inbound message that arrives while this transaction is open must
      // not be overwritten by an older outbound timestamp. The service window is
      // deliberately untouched — only the customer writing to us opens one.
      await tx.conversation.updateMany({
        where: { id: conversationId, lastMessageAt: { lt: draft.sentAt } },
        data: { lastMessageAt: draft.sentAt },
      });

      // Read back rather than assembled by hand, so the response and every
      // later read of this message are built from the same projection.
      return tx.message.findUniqueOrThrow({ where: { id }, select: MESSAGE_PROJECTION });
    });

    await this.queueDelivery(principal.tenantId, created.id, draft.template);
    await this.queueSlaEvaluation(principal.tenantId, conversation.contactId);
    this.events.emit(
      MESSAGE_CREATED_EVENT,
      toCreatedEvent(created, principal.tenantId, conversation.contactId),
    );

    return toMessageResponse(created, this.origin.require());
  }

  /**
   * The conversation, plus the two things a send reads that the response
   * projection does not carry — the contact's opt-out state and the number the
   * thread belongs to.
   *
   * `requireHeld` first, so visibility *and* the shared-pool write rule are
   * decided by the one function that decides them everywhere; this second read
   * then loads the send-specific columns rather than widening
   * `CONVERSATION_PROJECTION`, which every inbox row would pay for.
   *
   * `requireHeld` rather than `require` is TAR-186: a conversation nobody has
   * claimed is readable by every agent, and a send is the one act where that
   * would put two answers in front of the same customer.
   */
  private async loadSendTarget(conversationId: string): Promise<SendTarget> {
    await this.conversations.requireHeld(conversationId);

    return this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        id: true,
        whatsappAccountId: true,
        contactId: true,
        serviceWindowExpiresAt: true,
        contact: { select: { phoneE164: true, optedOutAt: true } },
      },
    });
  }

  /**
   * Turns a validated request into the row to write, refusing anything the
   * conversation's state or Meta's rules will not carry.
   *
   * The service-window branch is the whole point of the endpoint: inside the 24
   * hours anything goes, outside it only an approved template — and a
   * `whatsapp_window_expired` is what tells the composer to switch to the
   * template picker.
   */
  private async prepare(conversation: SendTarget, input: SendMessageInput): Promise<MessageDraft> {
    const sentAt = new Date();

    if (input.type === 'template') {
      return this.prepareTemplate(conversation, input, sentAt);
    }

    if (!isServiceWindowOpen(conversation, sentAt)) {
      throw new ServiceWindowExpiredError();
    }

    return input.type === 'text'
      ? {
          contentType: MessageContentType.text,
          body: input.body,
          attachment: null,
          template: undefined,
          sentAt,
        }
      : await this.prepareMedia(input, sentAt);
  }

  /**
   * A template send, which is legal in **both** window states — inside it
   * because a template is a message like any other, outside it because a
   * template is the only thing that is.
   */
  private async prepareTemplate(
    conversation: SendTarget,
    input: SendTemplateInput,
    sentAt: Date,
  ): Promise<MessageDraft> {
    const template = await this.templates.findApprovedForNumber({
      tenantId: this.tenantContext.requireTenantId(),
      whatsappAccountId: conversation.whatsappAccountId,
      name: input.templateName,
      language: input.languageCode,
    });

    if (template === null) {
      throw TemplateNotSendableError.notApproved(input.templateName);
    }

    const headerMedia =
      input.header !== undefined && isMediaHeader(input.header)
        ? await this.describeMedia(input.header.mediaId, 'header.mediaId')
        : null;

    assertTemplateSendable(input, template.summary, headerMedia);

    return {
      contentType: MessageContentType.template,
      // What the customer will see, reproduced locally so the thread is
      // readable. Meta renders the authoritative copy from its own approved
      // template; see `renderTemplateBody`.
      body: renderTemplateBody(template.summary.bodyText, input.variables),
      // The header's media is not attached to the message row. It is part of
      // the template's rendering rather than a file the agent sent, and an
      // attachment would put it in the thread twice — once in the rendered
      // template and once as a file beside it.
      attachment: null,
      template: {
        name: input.templateName,
        languageCode: input.languageCode,
        variables: input.variables,
        ...(input.header === undefined ? {} : { header: input.header }),
      },
      sentAt,
    };
  }

  private async prepareMedia(input: SendMediaInput, sentAt: Date): Promise<MessageDraft> {
    const media = await this.describeMedia(input.mediaId, 'mediaId');

    if (media.kind !== input.type) {
      throw new SendMediaNotUsableError(
        `That media is a ${media.kind} and the send declared a ${input.type}.`,
      );
    }

    return {
      contentType: MEDIA_CONTENT_TYPES[input.type],
      // The caption, which is what `MessageResponse.body` publishes for a media
      // message — "present for `text`, and used as the caption for media types".
      body: input.caption ?? null,
      attachment: {
        mediaObjectId: media.id,
        // A path, never an absolute URL: the same row is served through a
        // tenant's platform subdomain and through its custom domain, and the
        // origin is joined on at the response boundary (`message.mapper.ts`).
        url: mediaContentPath(media.id),
        kind: media.kind,
        // Outbound bytes are stored before the message exists, so there is no
        // pending state to represent.
        downloadState: MediaDownloadState.stored,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        filename: media.fileName,
      },
      template: undefined,
      sentAt,
    };
  }

  /**
   * A stored object, or the `validation_failed` naming the field that referred
   * to it. `MediaNotFoundError` covers both "no such id" and "another tenant's
   * id", which is what makes the two indistinguishable to a caller.
   */
  private async describeMedia(mediaId: string, field: string): Promise<MediaObjectRecord> {
    return this.media.describeForSend(mediaId).catch((error: unknown) => {
      if (error instanceof MediaNotFoundError) {
        throw new SendMediaNotUsableError(`${field} does not name an uploaded file.`);
      }

      throw error;
    });
  }

  /**
   * Hands the delivery to the worker. Never throws: the row is committed and
   * says `queued`, so a Redis blip costs a reply that has not gone out yet
   * rather than a request that fails after the message was already recorded.
   */
  private async queueDelivery(
    tenantId: string,
    messageId: string,
    template: OutboundTemplate | undefined,
  ): Promise<void> {
    const outcome = await this.queue.enqueue<SendOutboundMessageJob>(
      CONVERSATIONS_QUEUE,
      SEND_OUTBOUND_MESSAGE_JOB,
      { tenantId, messageId, ...(template === undefined ? {} : { template }) },
      {
        jobId: sendOutboundMessageJobId(messageId),
        attempts: SEND_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: SEND_RETRY_BACKOFF_MS },
        // The payload carries a template's variables, which are the customer's
        // own data. Dropping the job on success is the retention policy.
        removeOnComplete: true,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Message ${messageId} was recorded but not queued for delivery (${outcome}); it will stay queued.`,
      );
    }
  }

  /**
   * Tells the SLA module a person has replied (TAR-26, 0006's `agent_replied`
   * trigger).
   *
   * The job carries a ticket, so the contact's active ticket is looked up here —
   * one indexed read on `tickets_one_active_per_contact`, the same partial index
   * `TicketLinkerService` resolves the contact's live ticket with. No active
   * ticket means there is nothing with an SLA on it, which is the ordinary case
   * for a thread nobody has ticketed yet.
   *
   * It says *that* a reply happened, never *that the timer is met*: the handler
   * re-derives the first response from the messages, and the message this send
   * just committed is what it will find. That is why a lost job here is
   * recoverable rather than a permanently unmet timer — any later evaluation of
   * the same ticket reaches the same conclusion from the same rows.
   *
   * **A queue name, not an import.** `SlaModule` is L4 and this module is L3, so
   * naming it would be the sideways dependency the layering rule forbids. What
   * crosses is the shape in `@whatsappcrm/contracts/sla`.
   *
   * Never fails the send, per `QueueService`'s contract: the message is
   * committed and on its way to a customer, and a Redis blip must not turn that
   * into a 500 after the fact.
   */
  private async queueSlaEvaluation(tenantId: string, contactId: string): Promise<void> {
    const ticket = await this.prisma.ticket.findFirst({
      where: { tenantId, contactId, status: { in: TICKET_ACTIVE_STATUSES } },
      select: { id: true },
    });

    if (ticket === null) {
      return;
    }

    const trigger: SlaEvaluateTicketTrigger = {
      tenantId,
      ticketId: ticket.id,
      reason: 'agent_replied',
    };

    const outcome = await this.queue.enqueue<SlaEvaluateTicketTrigger>(
      SLA_QUEUE,
      SLA_EVALUATE_TICKET_JOB,
      trigger,
      {
        jobId: slaEvaluateJobId(trigger),
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Ticket ${ticket.id} was replied to but its SLA evaluation was not queued (${outcome}); ` +
          'the first-response timer will not stop until it is evaluated again.',
      );
    }
  }
}

/** `SendMediaInput.type` → the column's vocabulary. One entry per uploadable kind. */
const MEDIA_CONTENT_TYPES = {
  image: MessageContentType.image,
  video: MessageContentType.video,
  audio: MessageContentType.audio,
  document: MessageContentType.document,
} as const satisfies Record<SendMediaInput['type'], MessageContentType>;

/** Exactly the columns a send reads, which is not what a response publishes. */
type SendTarget = Prisma.ConversationGetPayload<{
  select: {
    id: true;
    whatsappAccountId: true;
    contactId: true;
    serviceWindowExpiresAt: true;
    contact: { select: { phoneE164: true; optedOutAt: true } };
  };
}>;

/** The row to write, once every refusal has been made. */
interface MessageDraft {
  readonly contentType: MessageContentType;
  readonly body: string | null;
  readonly attachment: AttachmentDraft | null;
  /** Present only for a template send; the worker's one piece of carried state. */
  readonly template: OutboundTemplate | undefined;
  readonly sentAt: Date;
}

/**
 * The attachment row an outbound media send writes. Declared structurally
 * rather than as Prisma's nested-create type: `message_attachments` reaches
 * both its message and its tenant through the same `tenant_id` column, so the
 * generated shape for a nested create is not the shape this draft is.
 */
interface AttachmentDraft {
  readonly mediaObjectId: string;
  readonly url: string;
  readonly kind: MediaKind;
  readonly downloadState: MediaDownloadState;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly filename: string | null;
}

/**
 * The realtime payload, from the row that was just written rather than from a
 * second read. Emitted after the commit — pushing a message to an agent's
 * screen that a rollback then un-wrote is worse than pushing it a moment later.
 */
function toCreatedEvent(
  message: MessageRow,
  tenantId: string,
  contactId: string,
): MessageCreatedEvent {
  return {
    tenantId,
    conversationId: message.conversationId,
    contactId,
    messageId: message.id,
    direction: message.direction,
    status: message.status,
    contentType: message.contentType,
    body: message.body,
    providerMessageId: message.providerMessageId,
    sentAt: message.sentAt,
  };
}
