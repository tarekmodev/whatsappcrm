import type { TicketResponse } from '@whatsappcrm/contracts';
import type { Content } from '@/lib/content';

/**
 * What to call a ticket in a sentence.
 *
 * `subject` is null on an auto-created ticket — the first inbound message is as
 * likely to be a photo as a sentence, so there is nothing honest to derive one
 * from. The number is what agents and customers actually quote, so it is the
 * fallback rather than a placeholder like "Untitled".
 *
 * One function because three places need the same answer: the table cell, the
 * assign button's accessible name and the success toast. Three copies is how a
 * screen-reader user ends up hearing a different ticket from the one they clicked.
 */
export function ticketLabel(ticket: TicketResponse, content: Content): string {
  return ticket.subject ?? content.assignment.untitledTicket(ticket.number);
}
