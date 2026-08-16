import type { ConversationResponse } from '@whatsappcrm/contracts';
import { CONTACT_PROJECTION, toContactResponse } from '../contacts/contact.mapper';
import type { Prisma } from '../generated/prisma/client';
import type { TicketStatus } from '../generated/prisma/enums';

/**
 * `conversations` → `ConversationResponse`.
 *
 * ## The projection is the response, and nothing else
 *
 * Written as a constant rather than a `select` per call site so the inbox list,
 * the detail read and every mutation that returns the resource load exactly the
 * same columns — a list endpoint that quietly loads more than it publishes is
 * the defect the craftsmanship rules call out by name, and three copies is how
 * one of them grows.
 *
 * ## Two published fields have no column, and are read rather than stored
 *
 *   * **`lastMessagePreview`** comes from the newest message in the thread, via
 *     a bounded relation load — `take: 1` on the `(tenant_id, conversation_id,
 *     sent_at DESC, id DESC)` index, which Prisma resolves as one extra query
 *     per page rather than one per row. Denormalising it onto `conversations`
 *     the way `last_message_at` and `unread_count` are would be faster still,
 *     and it would put a third field on every write path that inserts a message
 *     — the ingest writer, the send path, the status placeholder — for a
 *     read that is already an index scan over 25 rows. Worth revisiting with a
 *     measurement, not before one.
 *   * **`ticketId`** is the thread's active ticket, from the same shape.
 *     `tickets_one_active_per_contact` makes at most one exist, so `take: 1` is
 *     the whole answer rather than a truncation.
 *
 * ## `botHandling` is derived, and `botState` is the column
 *
 * TAR-28 shipped `conversations.bot_state` (0010 decision 5), so the field that
 * used to be a hardcoded `false` now reads a real state machine. `botHandling`
 * keeps its published meaning exactly — "the bot is answering and no human has
 * taken over" — which is `bot_state === 'bot_active'`, so a console running
 * yesterday's bundle is unaffected. `botState` is published alongside it because
 * the two things `botHandling` cannot distinguish, a thread the bot never
 * touched and one it released to a person, are rendered differently in the
 * inbox.
 */

/** Longest preview the inbox row renders. Beyond this the list is scrolling text, not a list. */
const PREVIEW_MAX_CHARS = 200;

/**
 * Statuses that make a ticket the thread's *active* one, per 0003's lifecycle.
 *
 * Declared with its type rather than `as const`, like the two orderings below.
 * `CONVERSATION_PROJECTION` is `as const` so `ConversationGetPayload` can read
 * the literal `true`s, and that would otherwise make every nested array readonly
 * — which Prisma's own input types are not.
 */
const ACTIVE_TICKET_STATUSES: TicketStatus[] = ['open', 'pending'];

/** Newest message first, with the id as the tie-breaker the sort needs to be total. */
const NEWEST_MESSAGE_FIRST: Prisma.MessageOrderByWithRelationInput[] = [
  { sentAt: 'desc' },
  { id: 'desc' },
];

/** Newest ticket first. At most one is active, so this only decides a tie. */
const NEWEST_TICKET_FIRST: Prisma.TicketOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

export const CONVERSATION_PROJECTION = {
  id: true,
  whatsappAccountId: true,
  status: true,
  assignedUserId: true,
  assignedTeamId: true,
  unreadCount: true,
  serviceWindowExpiresAt: true,
  botState: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
  contact: { select: CONTACT_PROJECTION },
  messages: {
    select: { body: true },
    orderBy: NEWEST_MESSAGE_FIRST,
    take: 1,
  },
  tickets: {
    select: { id: true },
    where: { status: { in: ACTIVE_TICKET_STATUSES } },
    orderBy: NEWEST_TICKET_FIRST,
    take: 1,
  },
} as const satisfies Prisma.ConversationSelect;

export type ConversationRow = Prisma.ConversationGetPayload<{
  select: typeof CONVERSATION_PROJECTION;
}>;

export function toConversationResponse(conversation: ConversationRow): ConversationResponse {
  return {
    id: conversation.id,
    contact: toContactResponse(conversation.contact),
    whatsappAccountId: conversation.whatsappAccountId,
    status: conversation.status,
    assignedUserId: conversation.assignedUserId,
    assignedTeamId: conversation.assignedTeamId,
    ticketId: conversation.tickets[0]?.id ?? null,
    unreadCount: conversation.unreadCount,
    serviceWindowExpiresAt: conversation.serviceWindowExpiresAt?.toISOString() ?? null,
    botHandling: conversation.botState === 'bot_active',
    botState: conversation.botState,
    lastMessagePreview: toPreview(conversation.messages[0]?.body ?? null),
    // Never null: `last_message_at` is `NOT NULL` (TAR-92) because it leads the
    // inbox's keyset indexes, and a thread with no message yet carries its own
    // creation time.
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

/**
 * The newest message's text, trimmed and truncated — or `null`.
 *
 * `null` for a message with no body is the honest answer rather than an
 * invented "📎 Attachment": the contract publishes the field as nullable, and
 * the label a client renders for a picture with no caption is a copy decision
 * that belongs in the console, in the reader's language.
 */
function toPreview(body: string | null): string | null {
  const preview = body?.trim() ?? '';

  if (preview === '') {
    return null;
  }

  return preview.length <= PREVIEW_MAX_CHARS ? preview : `${preview.slice(0, PREVIEW_MAX_CHARS)}…`;
}
