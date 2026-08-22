import 'server-only';

import { cache } from 'react';
import type { TicketResponse } from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { getTicket } from '@/lib/api/tickets';
import { loadDirectory, type Directory } from '@/features/inbox/directory.data';

/**
 * The ticket the open conversation is on, for the inbox's context column.
 *
 * `conversation.ticketId` names the **active** ticket and is all the thread read
 * carries, so reporting anything about it — its number, where triage has got to,
 * who owns it — is a second endpoint. It is its own loader, and its own Suspense
 * boundary in the panel, for the reason the chatbot summary is: a contact card
 * must never be held up, or taken down, by a read about something attached to it.
 *
 * ## `not_found` is an outcome, not a failure
 *
 * A ticket the reader may not see is answered `not_found`, never `forbidden`, so
 * nothing can be enumerated across colleagues — the same rule the thread read
 * follows. Left to throw it would become the section's error card with a Retry
 * that could never succeed. Here it means "there is a ticket and it is not
 * yours to read", and the panel says so in one line.
 */

export interface TicketSummaryData extends Directory {
  readonly ticket: TicketResponse;
}

export type TicketSummaryResult =
  | { readonly outcome: 'ready'; readonly summary: TicketSummaryData }
  /** The id names nothing this reader may see. Not an error — an answer. */
  | { readonly outcome: 'unavailable' };

export const loadTicketSummary = cache(async function loadTicketSummary(
  ticketId: string,
): Promise<TicketSummaryResult> {
  try {
    const [ticket, directory] = await Promise.all([getTicket(ticketId), loadDirectory()]);

    return { outcome: 'ready', summary: { ticket, ...directory } };
  } catch (error) {
    // Narrow, deliberately. Everything else — a 502, a malformed response, and
    // the `redirect` a lost session throws, which is not an `ApiRequestError` —
    // belongs to the boundary above.
    if (error instanceof ApiRequestError && error.code === NOT_FOUND_CODE) {
      return { outcome: 'unavailable' };
    }

    throw error;
  }
});

const NOT_FOUND_CODE = 'not_found';
