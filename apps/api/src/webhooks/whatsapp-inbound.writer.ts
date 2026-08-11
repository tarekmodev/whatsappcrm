import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MESSAGE_STATUSES, isMessageStatusAdvance } from '@whatsappcrm/contracts';
import {
  MESSAGE_CREATED_EVENT,
  MESSAGE_STATUS_CHANGED_EVENT,
  type MessageCreatedEvent,
  type MessageStatusChangedEvent,
} from '../events/domain-events';
import type { Prisma } from '../generated/prisma/client';
import {
  MediaDownloadState,
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '../generated/prisma/enums';
import { DOWNLOAD_INBOUND_MEDIA_JOB, MEDIA_QUEUE } from '../media/media.constants';
import { downloadInboundMediaJobId, type DownloadInboundMediaJob } from '../media/media-jobs';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { QueueService } from '../queue/queue.service';
import {
  toContentType,
  toFailureReason,
  toInboundMedia,
  toMessageBody,
  toMessageStatus,
  toPhoneE164,
  type InboundMediaDescriptor,
  type ProviderReportedStatus,
} from './whatsapp-message.mapper';
import type {
  WhatsAppInboundMessage,
  WhatsAppMessageStatusUpdate,
} from './whatsapp-payload.schema';

/**
 * Meta's 24-hour customer service window, measured from the customer's last
 * inbound message. Past it, only an approved template may be sent — which is why
 * the expiry is a stored column rather than something derived at read time.
 */
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** The number an event arrived on, already resolved to its owner. */
export interface RoutedWhatsAppAccount {
  readonly tenantId: string;
  readonly whatsappAccountId: string;
}

/** The customer profile Meta attaches to an inbound batch. */
export interface InboundProfile {
  readonly displayName: string | null;
}

/**
 * The timestamps a thread is born with.
 *
 * `serviceWindowExpiresAt` is null for a thread opened by a delivery receipt:
 * Meta's 24-hour customer service window is opened by the **customer** writing
 * to us, never by us hearing that something we sent was delivered.
 */
interface ConversationOpening {
  readonly lastMessageAt: Date;
  readonly serviceWindowExpiresAt: Date | null;
}

/**
 * Everything this pipeline writes inside a tenant's own database rows.
 *
 * Runs entirely on `TenantPrisma`, inside the scope the processor opened, so
 * every statement carries `app.tenant_id` and row-level security applies. The
 * one table it does not touch is `webhook_events` — that is `SystemPrisma`'s,
 * and lives in `WebhookEventsRepository`.
 *
 * ## Out-of-order delivery is the design constraint, not an edge case
 *
 * Meta does not guarantee delivery order and ingest is concurrent, so every
 * write here is expressed so that applying it twice, or applying an older event
 * after a newer one, changes nothing:
 *
 *   * threads sort by the provider's `sent_at`, never insert order;
 *   * `last_message_at`, `service_window_expires_at` and `last_seen_at` only
 *     ever move **forward**, guarded in the `WHERE` clause so the check and the
 *     write are one atomic statement rather than a read-modify-write two
 *     workers can interleave;
 *   * message status only ever advances (`isMessageStatusAdvance`), so a late
 *     `sent` cannot un-read a message;
 *   * a status webhook that overtakes the message it describes creates the row
 *     it needs, rather than being dropped or retried until Meta gives up.
 *
 * Domain events are emitted **after** the transaction commits. Emitting inside
 * would push a message to an agent's screen that a rollback then un-wrote. The
 * media-download job is queued after the commit for the same reason, and with
 * the same consequence if the queue is down: the row is durable and says the
 * bytes are owed, so nothing is lost that a re-queue cannot recover.
 */
@Injectable()
export class WhatsAppInboundWriter {
  private readonly logger = new Logger(WhatsAppInboundWriter.name);

  /**
   * Read from the same variable `InboundMediaDownloadService` reads, so BullMQ's
   * retry budget and the budget the handler parks on cannot drift. If the queue
   * gave up first the attachment would stay `pending` forever; if the handler
   * parked first the remaining attempts would be no-ops. One value, both places.
   */
  private readonly downloadAttempts: number;

  constructor(
    config: ConfigService,
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly events: EventEmitter2,
    private readonly queue: QueueService,
  ) {
    this.downloadAttempts = config.getOrThrow<number>('MEDIA_DOWNLOAD_MAX_ATTEMPTS');
  }

  /**
   * Records one inbound message, creating the contact and the thread if this is
   * the first time this customer has written to this number.
   *
   * Returns `false` when the message could not be attributed to a usable
   * contact — a `wa_id` that is not a phone number — so the caller can park the
   * event with a reason instead of writing a contact nothing will ever match.
   */
  async applyInboundMessage(
    account: RoutedWhatsAppAccount,
    message: WhatsAppInboundMessage,
    profile: InboundProfile,
  ): Promise<boolean> {
    const phoneE164 = toPhoneE164(message.from);

    if (phoneE164 === null) {
      return false;
    }

    const media = toInboundMedia(message);

    const created = await this.prisma.$tenantTransaction(async (tx) => {
      const contactId = await this.upsertContact(tx, account.tenantId, {
        phoneE164,
        displayName: profile.displayName,
        seenAt: message.timestamp,
      });

      const conversationId = await this.upsertConversation(tx, account, contactId, {
        lastMessageAt: message.timestamp,
        serviceWindowExpiresAt: serviceWindowEnd(message.timestamp),
      });

      // `skipDuplicates` is `ON CONFLICT (tenant_id, provider_message_id) DO
      // NOTHING`: an empty result means this exact message is already recorded,
      // and every counter below is therefore skipped. Incrementing an unread
      // count on a replay is how a thread ends up permanently showing unread
      // messages an agent has already read.
      const [stored] = await tx.message.createManyAndReturn({
        data: [
          {
            tenantId: account.tenantId,
            conversationId,
            direction: MessageDirection.inbound,
            status: MessageStatus.received,
            contentType: toContentType(message.type),
            body: toMessageBody(message),
            providerMessageId: message.id,
            sentAt: message.timestamp,
          },
        ],
        skipDuplicates: true,
        select: { id: true, status: true, contentType: true, body: true },
      });

      if (stored === undefined) {
        return null;
      }

      await this.advanceConversation(tx, account.tenantId, conversationId, message.timestamp);

      const attachmentId =
        media === null ? null : await this.recordAttachment(tx, account.tenantId, stored.id, media);

      return {
        attachmentId,
        event: {
          tenantId: account.tenantId,
          conversationId,
          contactId,
          messageId: stored.id,
          direction: MessageDirection.inbound,
          status: stored.status,
          contentType: stored.contentType,
          body: stored.body,
          providerMessageId: message.id,
          sentAt: message.timestamp,
        } satisfies MessageCreatedEvent,
      };
    });

    if (created !== null) {
      this.events.emit(MESSAGE_CREATED_EVENT, created.event);

      if (created.attachmentId !== null) {
        await this.queueMediaDownload(account, created.attachmentId);
      }
    }

    return true;
  }

  /**
   * Records that this message carries media, and that the bytes are owed.
   *
   * Written in the same transaction as the message so the two can never
   * disagree: a message whose media is only discovered by a job that may not
   * run is a message the inbox renders as empty text. The row is the durable
   * statement of intent; the job is only how it gets acted on.
   *
   * `url` and `size_bytes` stay null and `download_state` is `pending` — Meta's
   * inbound payload carries neither, and inventing them would mean publishing a
   * URL to bytes nobody has fetched.
   *
   * `skipDuplicates` on `(tenant_id, message_id, provider_media_id)`: a webhook
   * replay that somehow got past the message-level guard must not attach the
   * same media twice. An empty result means it is already recorded, and the
   * caller queues nothing — the first attempt already did.
   */
  private async recordAttachment(
    tx: Prisma.TransactionClient,
    tenantId: string,
    messageId: string,
    media: InboundMediaDescriptor,
  ): Promise<string | null> {
    const [attachment] = await tx.messageAttachment.createManyAndReturn({
      data: [
        {
          tenantId,
          messageId,
          kind: media.kind,
          downloadState: MediaDownloadState.pending,
          mimeType: media.mimeType,
          filename: media.fileName,
          providerMediaId: media.providerMediaId,
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });

    return attachment?.id ?? null;
  }

  /**
   * Hands the download to `MediaModule`'s queue.
   *
   * A job rather than a direct call, which is the whole reason this module does
   * not import that one: fetching the bytes is two more network calls and up to
   * 100 MB of transfer, and doing it here would run it inside the webhook's own
   * processing budget, behind Meta's retry timer, with the rest of the batch
   * waiting.
   *
   * Never throws. `enqueue` reports an outcome and logs, per `QueueService`'s
   * contract — the attachment row is already committed and says `pending`, so a
   * Redis blip costs a picture that has not arrived yet rather than a webhook
   * that fails and re-delivers the whole batch. The honest limitation, recorded
   * rather than glossed: nothing re-queues a `pending` attachment today, and
   * Meta's handle expires in five minutes, so a queue outage longer than that
   * loses the media. A sweep over `(tenant_id, download_state, created_at)` —
   * the index is already there — is the follow-up.
   */
  private async queueMediaDownload(
    account: RoutedWhatsAppAccount,
    messageAttachmentId: string,
  ): Promise<void> {
    const outcome = await this.queue.enqueue<DownloadInboundMediaJob>(
      MEDIA_QUEUE,
      DOWNLOAD_INBOUND_MEDIA_JOB,
      {
        tenantId: account.tenantId,
        messageAttachmentId,
        whatsappAccountId: account.whatsappAccountId,
      },
      {
        jobId: downloadInboundMediaJobId(messageAttachmentId),
        // Meta's URL is good for five minutes, so the backoff is measured in
        // seconds rather than minutes: three attempts at 2s, 4s and 8s all fall
        // inside the window, and a longer schedule would only park the
        // attachment more slowly.
        attempts: this.downloadAttempts,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Media for attachment ${messageAttachmentId} was recorded but not queued (${outcome}); ` +
          'it will stay pending.',
      );
    }
  }

  /**
   * Applies one status transition for a message we sent.
   *
   * Returns `false` only when the update could not be attributed — the same
   * `wa_id` problem as above. A status Meta reports but this product does not
   * model (`deleted`) is a successful no-op, not a failure: parking the event
   * would make every future Meta status value an ingestion outage.
   */
  async applyStatusUpdate(
    account: RoutedWhatsAppAccount,
    update: WhatsAppMessageStatusUpdate,
  ): Promise<boolean> {
    const status = toMessageStatus(update.status);

    if (status === undefined) {
      return true;
    }

    const phoneE164 = toPhoneE164(update.recipient_id);

    if (phoneE164 === null) {
      return false;
    }

    const emitted = await this.prisma.$tenantTransaction(async (tx) => {
      const existing = await tx.message.findUnique({
        where: {
          tenantId_providerMessageId: { tenantId: account.tenantId, providerMessageId: update.id },
        },
        select: { id: true, conversationId: true },
      });

      if (existing === null) {
        const placeholder = await this.createStatusPlaceholder(
          tx,
          account,
          update,
          status,
          phoneE164,
        );

        if (placeholder !== null) {
          return { name: MESSAGE_CREATED_EVENT, payload: placeholder } as const;
        }
        // Lost the race to a concurrent worker that created the row first; fall
        // through and apply this status to it like any other update.
      }

      const advanced = await this.advanceMessageStatus(tx, account.tenantId, update, status);

      if (!advanced) {
        return null;
      }

      const message =
        existing ??
        (await tx.message.findUniqueOrThrow({
          where: {
            tenantId_providerMessageId: {
              tenantId: account.tenantId,
              providerMessageId: update.id,
            },
          },
          select: { id: true, conversationId: true },
        }));

      return {
        name: MESSAGE_STATUS_CHANGED_EVENT,
        payload: {
          tenantId: account.tenantId,
          conversationId: message.conversationId,
          messageId: message.id,
          status,
          providerMessageId: update.id,
        } satisfies MessageStatusChangedEvent,
      } as const;
    });

    if (emitted !== null) {
      this.events.emit(emitted.name, emitted.payload);
    }

    return true;
  }

  /**
   * The contact, created on first contact and otherwise left alone but for two
   * fields.
   *
   * `last_seen_at` is advanced in its own guarded statement rather than inside
   * the upsert: an upsert would write whatever timestamp this event carries, and
   * a webhook that arrives late would then move the contact backwards in time.
   */
  private async upsertContact(
    tx: Prisma.TransactionClient,
    tenantId: string,
    {
      phoneE164,
      displayName,
      seenAt,
    }: { phoneE164: string; displayName: string | null; seenAt: Date },
  ): Promise<string> {
    const contact = await tx.contact.upsert({
      where: { tenantId_phoneE164: { tenantId, phoneE164 } },
      create: { tenantId, phoneE164, displayName, lastSeenAt: seenAt },
      // A profile name Meta stopped sending must not blank out one we hold.
      update: displayName === null ? {} : { displayName },
      select: { id: true },
    });

    await tx.contact.updateMany({
      where: {
        tenantId,
        id: contact.id,
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: seenAt } }],
      },
      data: { lastSeenAt: seenAt },
    });

    return contact.id;
  }

  /**
   * One thread per contact per WhatsApp number — the schema's unique constraint.
   *
   * A thread that is being created carries its opening timestamps immediately,
   * rather than being created blank and advanced by the guarded update below.
   * That is not a shortcut, it is what makes this path correct at all now that
   * TAR-92 has made `conversations.last_message_at` `NOT NULL DEFAULT
   * CURRENT_TIMESTAMP`: left to the default, a new thread starts at *row
   * creation time*, which is later than the provider timestamp that created it —
   * `sent_at` is Meta's clock, in whole seconds, and this runs off the request
   * path. The forward-only guard below would then never match for the first
   * message, so `service_window_expires_at` would stay NULL, which reads as
   * "window closed": a thread minutes old offering the agent a template-only
   * composer. Setting both here is what opens the window.
   *
   * The default is still right for the thread TAR-68 opens with no message in
   * it. It is only wrong when a message is what created the row, which is
   * exactly this path, so this is where it is corrected.
   *
   * Updates stay empty on purpose: an existing thread's counters and timestamps
   * are conditional, and an upsert cannot express "only if this event is newer".
   */
  private async upsertConversation(
    tx: Prisma.TransactionClient,
    { tenantId, whatsappAccountId }: RoutedWhatsAppAccount,
    contactId: string,
    opening: ConversationOpening,
  ): Promise<string> {
    const conversation = await tx.conversation.upsert({
      where: {
        tenantId_whatsappAccountId_contactId: { tenantId, whatsappAccountId, contactId },
      },
      create: {
        tenantId,
        whatsappAccountId,
        contactId,
        lastMessageAt: opening.lastMessageAt,
        serviceWindowExpiresAt: opening.serviceWindowExpiresAt,
      },
      update: {},
      select: { id: true },
    });

    return conversation.id;
  }

  /**
   * Moves the inbox row forward for a newly stored inbound message.
   *
   * Two statements because they answer different questions. The unread count is
   * a count: a message that arrived out of order is still one more unread
   * message. `last_message_at` and the service window are a high-water mark:
   * they may only move forward, and the guard lives in the `WHERE` clause so
   * the comparison and the write are one atomic UPDATE.
   *
   * The guard is `lastMessageAt < sentAt` and nothing else: the column is
   * `NOT NULL` since TAR-92, so a `lastMessageAt: null` branch would be dead
   * code that reads as a case still being handled. For the message that created
   * the thread the comparison is an equality and this correctly writes nothing —
   * `upsertConversation` has already stamped both fields from that same message.
   *
   * `status` is deliberately untouched. Whether an inbound message re-opens a
   * resolved conversation is a product rule that belongs with the inbox
   * (TAR-20c) and the ticket lifecycle (TAR-21), not with the transport.
   */
  private async advanceConversation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    conversationId: string,
    sentAt: Date,
  ): Promise<void> {
    await tx.conversation.updateMany({
      where: { tenantId, id: conversationId },
      data: { unreadCount: { increment: 1 } },
    });

    await tx.conversation.updateMany({
      where: { tenantId, id: conversationId, lastMessageAt: { lt: sentAt } },
      data: { lastMessageAt: sentAt, serviceWindowExpiresAt: serviceWindowEnd(sentAt) },
    });
  }

  /**
   * Creates the row a status webhook needs when it overtakes the message it
   * describes.
   *
   * Meta reports `sent`/`delivered`/`read` for messages **we** sent, so the
   * placeholder is outbound and carries no body — the send path owns the
   * content, and this is the transport admitting it heard about the message
   * before it heard about itself. Recording it is what makes the thread
   * complete; dropping it would lose a delivery receipt for a message the agent
   * can see.
   *
   * Returns `null` when a concurrent worker won the race, so the caller applies
   * the status to that row instead.
   */
  private async createStatusPlaceholder(
    tx: Prisma.TransactionClient,
    account: RoutedWhatsAppAccount,
    update: WhatsAppMessageStatusUpdate,
    status: ProviderReportedStatus,
    phoneE164: string,
  ): Promise<MessageCreatedEvent | null> {
    const contactId = await this.upsertContact(tx, account.tenantId, {
      phoneE164,
      displayName: null,
      seenAt: update.timestamp,
    });
    const conversationId = await this.upsertConversation(tx, account, contactId, {
      lastMessageAt: update.timestamp,
      // A delivery receipt is not the customer writing to us, so it opens no
      // service window. Only an inbound message does.
      serviceWindowExpiresAt: null,
    });
    const failure = toFailureReason(update.errors);

    const [stored] = await tx.message.createManyAndReturn({
      data: [
        {
          tenantId: account.tenantId,
          conversationId,
          direction: MessageDirection.outbound,
          status,
          contentType: MessageContentType.text,
          providerMessageId: update.id,
          sentAt: update.timestamp,
          ...statusTimestamp(status, update.timestamp),
          ...(status === 'failed' ? failure : {}),
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });

    if (stored === undefined) {
      return null;
    }

    return {
      tenantId: account.tenantId,
      conversationId,
      contactId,
      messageId: stored.id,
      direction: MessageDirection.outbound,
      status,
      contentType: MessageContentType.text,
      body: null,
      providerMessageId: update.id,
      sentAt: update.timestamp,
    };
  }

  /**
   * Applies the status only if it advances, in one statement.
   *
   * The allowed prior statuses come from the published ladder
   * (`isMessageStatusAdvance`), evaluated into a `WHERE status IN (…)` so the
   * comparison happens inside the UPDATE. A read-then-write would let two
   * workers holding `delivered` and `read` interleave and leave the message
   * `delivered`.
   *
   * `received` is absent from `MESSAGE_STATUSES` and therefore from the allowed
   * set, which is correct: that is the terminal state of an **inbound** message,
   * and no status webhook describes one.
   */
  private async advanceMessageStatus(
    tx: Prisma.TransactionClient,
    tenantId: string,
    update: WhatsAppMessageStatusUpdate,
    status: ProviderReportedStatus,
  ): Promise<boolean> {
    const advanceableFrom = MESSAGE_STATUSES.filter((from) => isMessageStatusAdvance(from, status));

    if (advanceableFrom.length === 0) {
      return false;
    }

    const { count } = await tx.message.updateMany({
      where: { tenantId, providerMessageId: update.id, status: { in: advanceableFrom } },
      data: {
        status,
        ...statusTimestamp(status, update.timestamp),
        ...(status === 'failed' ? toFailureReason(update.errors) : {}),
      },
    });

    return count > 0;
  }
}

/** When Meta's 24-hour customer service window closes, measured from `sentAt`. */
function serviceWindowEnd(sentAt: Date): Date {
  return new Date(sentAt.getTime() + SERVICE_WINDOW_MS);
}

/**
 * The column that records *when* a status happened. Separate from `status`
 * because the product reads both: `status` answers "where is this message now",
 * the timestamps answer "when did each step happen", which is what an SLA
 * report needs.
 */
function statusTimestamp(
  status: ProviderReportedStatus,
  at: Date,
): Partial<Record<'deliveredAt' | 'readAt' | 'failedAt', Date>> {
  switch (status) {
    case 'delivered':
      return { deliveredAt: at };
    case 'read':
      return { readAt: at };
    case 'failed':
      return { failedAt: at };
    default:
      return {};
  }
}
