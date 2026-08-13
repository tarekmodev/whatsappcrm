import 'server-only';

import { cache } from 'react';
import type { ConversationResponse, TicketResponse } from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { getConversation } from '@/lib/api/conversations';
import { getTicket, listTickets } from '@/lib/api/tickets';
import { loadDirectory, type Directory } from '@/features/inbox/directory.data';
import { TICKETS_PAGE_SIZE } from '@/features/tickets/constants';
import type { TicketQueueParams } from '@/features/tickets/ticket-params';

/**
 * The two reads behind the ticket surface.
 *
 * Both are refetch-on-view: ADR 0006 §9 decides against a socket subscription
 * for this story, because a ticket audience is not a conversation audience and
 * the rooms amendment that would make one safe is not reviewable under a
 * status-change story. Both routes are `force-dynamic`, so an auto-reopen that
 * happened while the agent was elsewhere is visible the moment they look.
 */

export interface TicketQueueData extends Directory {
  /**
   * In the order the API returned them — `priority DESC, createdAt DESC` — and
   * never re-sorted here. The order is the contract's (ADR 0006 §6); a second
   * copy of it in the console is how a list and its cursor drift apart.
   */
  readonly tickets: readonly TicketResponse[];
}

export async function loadTicketQueue(query: TicketQueueParams): Promise<TicketQueueData> {
  const [page, directory] = await Promise.all([
    listTickets({
      scope: query.scope,
      status: query.status,
      priority: query.priority,
      breachedOnly: false,
      limit: TICKETS_PAGE_SIZE,
    }),
    loadDirectory(),
  ]);

  return { tickets: page.items, ...directory };
}

export interface TicketDetailData extends Directory {
  readonly ticket: TicketResponse;
  /**
   * The conversation the ticket was opened from, when the reader may see it.
   *
   * `null` covers two different things on purpose — a ticket with no
   * conversation behind it, and one whose conversation is outside this reader's
   * scope — and the panel distinguishes them from `ticket.conversationId`.
   * Ticket visibility and conversation visibility are separate rules, so a
   * readable ticket on an unreadable thread is reachable rather than theoretical.
   */
  readonly conversation: ConversationResponse | null;
}

export type TicketDetailResult =
  | { readonly outcome: 'ready'; readonly detail: TicketDetailData }
  /** The id names nothing this reader may see. Not an error — an answer. */
  | { readonly outcome: 'unavailable' };

/**
 * One ticket, its conversation and the names behind its assignment.
 *
 * Request-cached so the header and the controls beside it are one read rather
 * than two; it memoises per render pass only, so a status changed between
 * requests is never carried over.
 *
 * `not_found` is returned as a state rather than thrown. The API answers it for
 * a ticket the reader may not see — never `forbidden`, so nothing can be
 * enumerated — and left to throw that becomes a generic "something went wrong"
 * card with a Retry button that can never succeed.
 */
export const loadTicketDetail = cache(async function loadTicketDetail(
  ticketId: string,
): Promise<TicketDetailResult> {
  let ticket: TicketResponse;

  try {
    ticket = await getTicket(ticketId);
  } catch (error) {
    // Narrow, deliberately. A 502, a malformed response and the `redirect` a lost
    // session throws all belong to the boundary above.
    if (error instanceof ApiRequestError && error.code === NOT_FOUND_CODE) {
      return { outcome: 'unavailable' };
    }

    throw error;
  }

  const [conversation, directory] = await Promise.all([
    loadTicketConversation(ticket.conversationId),
    loadDirectory(),
  ]);

  return { outcome: 'ready', detail: { ticket, conversation, ...directory } };
});

/**
 * The conversation, or `null` when there is none or the reader cannot open it.
 *
 * Swallowing `not_found` here is deliberate and bounded: the ticket has already
 * loaded, so this is a side panel on a page that renders either way, and the
 * only alternative is failing the whole view over a link it could simply not
 * offer. Every other failure still reaches the boundary.
 */
async function loadTicketConversation(
  conversationId: string | null,
): Promise<ConversationResponse | null> {
  if (conversationId === null) {
    return null;
  }

  try {
    return await getConversation(conversationId);
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === NOT_FOUND_CODE) {
      return null;
    }

    throw error;
  }
}

const NOT_FOUND_CODE = 'not_found';
