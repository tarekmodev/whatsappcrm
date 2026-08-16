import 'server-only';

import { cache } from 'react';
import { ApiRequestError } from '@/lib/api/http';
import { listTicketEvents } from '@/lib/api/tickets';
import { loadDirectory } from '@/features/inbox/directory.data';
import { TICKET_HISTORY_PAGE_SIZE } from '@/features/tickets/constants';
import { toHistoryEntries, type TicketHistoryEntry } from '@/features/tickets/ticket-history';

/**
 * One ticket's audit trail, flattened into what the panel renders.
 *
 * ## Why a view model rather than the raw page
 *
 * The events carry ids — an actor, an assignment's four sides, an escalation's
 * recipient — and the names behind them come from a `server-only` directory
 * read. Resolving them here means the panel renders strings, and the rule for
 * "a name this reader cannot resolve" lives in exactly one place.
 *
 * ## Scoping
 *
 * There is nothing to filter. `GET /tickets/{id}/events` runs the ticket through
 * the same visibility rule the ticket GET does, so a principal who may not open
 * the ticket gets `not_found` from the API rather than a page this module then
 * has to trim.
 */

export interface TicketHistoryData {
  readonly entries: readonly TicketHistoryEntry[];
  /**
   * True when the API had more than one page. The panel says "older entries are
   * not shown" rather than a count it would have to page the whole log to know.
   */
  readonly hasMore: boolean;
}

export type TicketHistoryResult =
  | { readonly outcome: 'ready'; readonly history: TicketHistoryData }
  /** The ticket names nothing this reader may see. Not an error — an answer. */
  | { readonly outcome: 'unavailable' };

/**
 * Request-cached, memoised per render pass only, so an event written between
 * requests is never carried over.
 *
 * `not_found` comes back as a state rather than a throw, for the reason
 * `loadTicketDetail` gives: left to throw it becomes a generic "something went
 * wrong" card with a Retry button that can never succeed. Every other failure —
 * a 502, a malformed response — still reaches the section's error boundary.
 */
export const loadTicketHistory = cache(async function loadTicketHistory(
  ticketId: string,
): Promise<TicketHistoryResult> {
  let page: Awaited<ReturnType<typeof listTicketEvents>>;

  try {
    page = await listTicketEvents(ticketId, { limit: TICKET_HISTORY_PAGE_SIZE });
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === NOT_FOUND_CODE) {
      return { outcome: 'unavailable' };
    }

    throw error;
  }

  const directory = await loadDirectory();

  return {
    outcome: 'ready',
    history: {
      // In the order the API returned them — `createdAt DESC, id DESC` — and
      // never re-sorted here. A second copy of the order is how a list and its
      // cursor drift apart.
      entries: toHistoryEntries(page.items, directory),
      hasMore: page.nextCursor !== null,
    },
  };
});

const NOT_FOUND_CODE = 'not_found';
