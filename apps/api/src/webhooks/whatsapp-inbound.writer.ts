import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MESSAGE_STATUSES, isMessageStatusAdvance } from '@whatsappcrm/contracts';
import {
  MESSAGE_CREATED_EVENT,
  MESSAGE_STATUS_CHANGED_EVENT,
  type MessageCreatedEvent,
  type MessageStatusChangedEvent,
} from '../events/domain-events';
import type { Prisma } from '../generated/prisma/client';
import { MessageContentType, MessageDirection, MessageStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  toContentType,
  toFailureReason,
  toMessageBody,
  toMessageStatus,
  toPhoneE164,
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
 * would push a message to an agent's screen that a rollback then un-wrote.
 */
@Injectable()
export class WhatsAppInboundWriter {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly events: EventEmitter2,
  ) {}

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

    const created = await this.prisma.$tenantTransaction(async (tx) => {
      const contactId = await this.upsertContact(tx, account.tenantId, {
        phoneE164,
        displayName: profile.displayName,
        seenAt: message.timestamp,
      });

      const conversationId = await this.upsertConversation(tx, account, contactId);

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

      return {
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
      } satisfies MessageCreatedEvent;
    });

    if (created !== null) {
      this.events.emit(MESSAGE_CREATED_EVENT, created);
    }

    return true;
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

  /** One thread per contact per WhatsApp number — the schema's unique constraint. */
  private async upsertConversation(
    tx: Prisma.TransactionClient,
    { tenantId, whatsappAccountId }: RoutedWhatsAppAccount,
    contactId: string,
  ): Promise<string> {
    const conversation = await tx.conversation.upsert({
      where: {
        tenantId_whatsappAccountId_contactId: { tenantId, whatsappAccountId, contactId },
      },
      create: { tenantId, whatsappAccountId, contactId },
      // Counters and timestamps are advanced separately and conditionally; an
      // upsert cannot express "only if this event is newer".
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
      where: {
        tenantId,
        id: conversationId,
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: sentAt } }],
      },
      data: {
        lastMessageAt: sentAt,
        serviceWindowExpiresAt: new Date(sentAt.getTime() + SERVICE_WINDOW_MS),
      },
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
    const conversationId = await this.upsertConversation(tx, account, contactId);
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
