import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  TENANT_STATUS_EFFECTS,
  UPLOADABLE_MEDIA_KINDS,
  type MediaKind,
  type SendTemplateHeader,
  type TenantStatus,
  type UploadableMediaKind,
} from '@whatsappcrm/contracts';
import { describeFailure } from '../common/describe-failure';
import { TenantOutboundNotAllowedError } from './conversations.errors';
import {
  MESSAGE_STATUS_CHANGED_EVENT,
  type MessageStatusChangedEvent,
} from '../events/domain-events';
import type { Prisma } from '../generated/prisma/client';
import { MessageStatus } from '../generated/prisma/enums';
import { MediaSendResolver } from '../media/media-send.resolver';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import type { SentMessage, TemplateHeader } from '../whatsapp/meta-cloud-api.client';
import {
  MetaCloudApiError,
  MetaRateLimitedError,
  MetaUnavailableError,
} from '../whatsapp/meta-cloud-api.errors';
import { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service';
import { SEND_MAX_ATTEMPTS } from './conversations.constants';
import { isMediaHeader } from './template-send.validator';
import type { OutboundTemplate, SendOutboundMessageJob } from './outbound-message.jobs';

/**
 * Delivers one `queued` message to Meta.
 *
 * A plain class the queue runner dispatches into, rather than a decorated
 * processor — the same arrangement `InboundMediaDownloadService` uses, and for
 * the same reason: the retry and idempotency behaviour below is exactly what
 * needs testing, and it is testable only if calling it does not require Redis.
 *
 * ## What makes a redelivery safe
 *
 * The `status = queued` guard, on the row, in the `WHERE` clause of the write
 * that follows the send. BullMQ's job id collapses an obvious duplicate, but it
 * forgets an id once the job leaves the completed set, so it is an optimisation
 * and not the mechanism. A message already `sent`, `delivered`, `read` or
 * `failed` is left exactly as it is and this returns quietly — which is what
 * turns a worker that crashed after Meta accepted the send into lateness rather
 * than a second message to the customer.
 *
 * The window that guard does **not** close is the one between Meta accepting a
 * send and this process recording it: a crash in that instant loses the
 * provider id, the job is retried, and the customer receives the message twice.
 * Closing it properly needs an idempotency key Meta honours, which the Cloud API
 * does not offer for messages. It is recorded rather than glossed, and it is the
 * reason the retry budget below is small.
 *
 * ## Which failures are retried
 *
 * Only the ones a retry can fix: Meta unreachable, and Meta throttling. A
 * rejected request and a rejected credential will fail identically however many
 * times they are repeated — retrying either burns rate limit and, for a
 * credential, is what gets an app flagged. Those are written to the row as
 * `failed`, with Meta's own code, so the agent sees why.
 */
@Injectable()
export class OutboundMessageDispatcher {
  private readonly logger = new Logger(OutboundMessageDispatcher.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly sender: WhatsAppSenderService,
    private readonly media: MediaSendResolver,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * @param attempt one-based, so the handler reasons in "attempt 1 of 3" — the
   *   numbering its configuration and its log lines use.
   */
  async deliver(job: SendOutboundMessageJob, attempt: number): Promise<void> {
    const message = await this.load(job.messageId);

    if (message === null) {
      // The row is gone: a tenant deleted between enqueue and pickup. Nothing to
      // deliver and nothing wrong.
      this.logger.warn(`Message ${job.messageId} no longer exists; nothing was sent.`);

      return;
    }

    if (message.status !== MessageStatus.queued) {
      // Already delivered or already failed. The guard that makes a redelivery
      // a no-op rather than a second message.
      return;
    }

    const refusedBy = await this.statusRefusingOutbound();

    if (refusedBy !== null) {
      // Stage 4 cannot see this path: it is an HTTP guard and this is a queue
      // worker. See `TenantOutboundNotAllowedError` for why the check lives here
      // and why the message is failed rather than held.
      await this.recordFailed(message, new TenantOutboundNotAllowedError(refusedBy));

      return;
    }

    try {
      const sent = await this.send(message, job.template);

      await this.recordSent(message, sent);
    } catch (error: unknown) {
      if (isWorthRetrying(error) && attempt < SEND_MAX_ATTEMPTS) {
        // Thrown on purpose: BullMQ owns the backoff, and a handler that
        // swallowed this would turn a transient Meta blip into a failed message.
        throw error;
      }

      await this.recordFailed(message, error);
    }
  }

  /**
   * The tenant's status when it forbids outbound traffic, or `null` when the
   * send may proceed.
   *
   * Reads `TENANT_STATUS_EFFECTS` rather than restating which states are closed:
   * that table is the published contract, `contract.test.ts` pins
   * `suspended.outboundAllowed === false`, and a second copy here is one that
   * drifts from it. `past_due` deliberately still sends — dunning is a banner,
   * not an outage.
   *
   * One indexed read on the tenant in scope, on a path that already makes
   * several. `Tenant` is `own-row` in `tenant-scope.extension.ts`, so the query
   * is narrowed to this worker's tenant by the extension rather than by a filter
   * written here; a row that has gone missing reads as refused, which is the
   * fail-closed direction for a send.
   */
  private async statusRefusingOutbound(): Promise<TenantStatus | null> {
    const tenant = await this.prisma.tenant.findFirst({ select: { status: true } });

    if (tenant === null) {
      return 'deleted';
    }

    return TENANT_STATUS_EFFECTS[tenant.status].outboundAllowed ? null : tenant.status;
  }

  private async send(
    message: DeliverableMessage,
    template: OutboundTemplate | undefined,
  ): Promise<SentMessage> {
    const whatsappAccountId = message.conversation.whatsappAccountId;
    const to = message.conversation.contact.phoneE164;

    if (template !== undefined) {
      return this.sender.sendTemplate({
        whatsappAccountId,
        to,
        templateName: template.name,
        languageCode: template.languageCode,
        variables: template.variables,
        ...(template.header === undefined
          ? {}
          : { header: await this.resolveHeader(template.header, whatsappAccountId) }),
      });
    }

    const attachment = message.attachments[0];

    if (attachment !== undefined && attachment.mediaObjectId !== null) {
      if (!isSendableMediaKind(attachment.kind)) {
        // Unreachable through this API — `UPLOADABLE_MEDIA_KINDS` refuses a
        // sticker at upload, and the send endpoint refuses a mismatch — so this
        // is a fault rather than a rejection, and it fails loudly instead of
        // guessing a kind Meta would refuse anyway.
        throw new Error(
          `Message ${message.id} carries a ${attachment.kind}, which cannot be sent.`,
        );
      }

      return this.sender.sendMedia({
        whatsappAccountId,
        to,
        kind: attachment.kind,
        // Uploaded to Meta now rather than at composer time: the handle is
        // scoped to this number and expires on Meta's schedule, so it cannot be
        // cached.
        media: await this.media.resolveForSend(attachment.mediaObjectId, whatsappAccountId),
        ...(message.body === null ? {} : { caption: message.body }),
        ...(attachment.filename === null ? {} : { fileName: attachment.filename }),
      });
    }

    return this.sender.sendText({ whatsappAccountId, to, body: message.body ?? '' });
  }

  /**
   * The contract's header union, with any media in it turned into a handle Meta
   * holds. The formats are already known to agree with the approved template —
   * `assertTemplateSendable` decided that before the row was written — so this
   * is a transport conversion and nothing more.
   */
  private async resolveHeader(
    header: SendTemplateHeader,
    whatsappAccountId: string,
  ): Promise<TemplateHeader> {
    if (!isMediaHeader(header)) {
      return header;
    }

    return {
      format: header.format,
      media: await this.media.resolveForSend(header.mediaId, whatsappAccountId),
      ...(header.fileName === undefined ? {} : { fileName: header.fileName }),
    };
  }

  /**
   * Records Meta's acceptance, guarded on the row still being `queued` so a
   * concurrent worker cannot overwrite a status that has already moved on — a
   * `delivered` webhook can legitimately arrive before this write lands.
   */
  private async recordSent(message: DeliverableMessage, sent: SentMessage): Promise<void> {
    const { count } = await this.prisma.message.updateMany({
      where: { id: message.id, status: MessageStatus.queued },
      data: { status: MessageStatus.sent, providerMessageId: sent.providerMessageId },
    });

    if (count > 0) {
      this.emit(message, MessageStatus.sent, sent.providerMessageId);
    }
  }

  /**
   * Records a refusal, with Meta's own code and title where there is one —
   * which is what `MessageResponse.failureReason` publishes to the agent.
   */
  private async recordFailed(message: DeliverableMessage, error: unknown): Promise<void> {
    const errorCode =
      error instanceof MetaCloudApiError && error.detail?.code !== null
        ? String(error.detail?.code)
        : null;

    this.logger.warn(`Message ${message.id} could not be sent: ${describeSendFailure(error)}`);

    const { count } = await this.prisma.message.updateMany({
      where: { id: message.id, status: MessageStatus.queued },
      data: {
        status: MessageStatus.failed,
        failedAt: new Date(),
        errorCode,
        errorMessage: describeSendFailure(error),
      },
    });

    if (count > 0) {
      this.emit(message, MessageStatus.failed, null);
    }
  }

  private emit(
    message: DeliverableMessage,
    status: MessageStatus,
    providerMessageId: string | null,
  ): void {
    this.events.emit(MESSAGE_STATUS_CHANGED_EVENT, {
      tenantId: message.tenantId,
      conversationId: message.conversationId,
      messageId: message.id,
      status,
      providerMessageId,
    } satisfies MessageStatusChangedEvent);
  }

  private async load(messageId: string): Promise<DeliverableMessage | null> {
    return this.prisma.message.findUnique({
      where: { id: messageId },
      select: DELIVERABLE_PROJECTION,
    });
  }
}

/** See `message.mapper.ts` for why an ordering is declared rather than inlined. */
const BY_ID: Prisma.MessageAttachmentOrderByWithRelationInput = { id: 'asc' };

/**
 * Exactly what a delivery reads. The recipient and the number come from the
 * conversation rather than from the job payload, so a customer's phone number
 * is not also sitting in Redis (`outbound-message.jobs.ts`).
 */
const DELIVERABLE_PROJECTION = {
  id: true,
  tenantId: true,
  conversationId: true,
  status: true,
  body: true,
  conversation: {
    select: { whatsappAccountId: true, contact: { select: { phoneE164: true } } },
  },
  attachments: {
    select: { mediaObjectId: true, kind: true, filename: true },
    orderBy: BY_ID,
    // One media object per message: Meta accepts exactly one, and the send
    // endpoint writes at most one.
    take: 1,
  },
} as const satisfies Prisma.MessageSelect;

type DeliverableMessage = Prisma.MessageGetPayload<{ select: typeof DELIVERABLE_PROJECTION }>;

/**
 * Meta unreachable or throttling — the two failures a later attempt can fix.
 *
 * Everything else is terminal by construction: `MetaRequestRejectedError` is
 * Meta having read the request and refused it, `MetaAuthenticationError` is a
 * credential the tenant has to replace, and anything that is not a Cloud API
 * error at all — an unreadable media object, a missing token — is a fault a
 * retry would repeat identically.
 */
function isWorthRetrying(error: unknown): boolean {
  return error instanceof MetaUnavailableError || error instanceof MetaRateLimitedError;
}

/**
 * Why a send failed, in words an agent can read.
 *
 * Meta's own description for a Cloud API failure — those error types are
 * written never to carry the access token, the request body or a message body,
 * so it is safe to store and to publish as `MessageResponse.failureReason`.
 * Anything else falls back to `describeFailure`, which reports a class and a
 * system code and nothing more: a fault that is not Meta's answer may quote an
 * internal path, and this string reaches a client.
 */
function describeSendFailure(error: unknown): string {
  if (error instanceof MetaCloudApiError) {
    return error.detail?.message ?? error.message;
  }

  if (error instanceof TenantOutboundNotAllowedError) {
    // The second error whose own message is safe to publish, and for the same
    // reason Meta's is: it is a sentence written for the agent reading it, with
    // no path, no id and no internal name in it. Without this branch
    // `describeFailure` would reduce it to the class name, and
    // `MessageResponse.failureReason` would read "TenantOutboundNotAllowedError"
    // — which tells the one person who has to act on it nothing at all.
    return error.message;
  }

  return describeFailure(error);
}

/**
 * `media_kind` is wider than what a message may carry outbound: `sticker` is
 * inbound-only, because sending one needs a sticker pack registered with Meta
 * that this product does not model (`UPLOADABLE_MEDIA_KINDS`).
 */
function isSendableMediaKind(kind: MediaKind): kind is UploadableMediaKind {
  return (UPLOADABLE_MEDIA_KINDS as readonly string[]).includes(kind);
}
