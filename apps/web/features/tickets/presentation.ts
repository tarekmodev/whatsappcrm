import {
  TICKET_PRIORITIES,
  TICKET_STATUS_REQUIRES_CLOSE,
  TICKET_STATUS_TRANSITIONS,
  type TicketPriority,
  type TicketResponse,
  type TicketStatus,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { BadgeTone } from '@/components/ui/Badge';
import type { SelectOption } from '@/components/ui/Select';

/**
 * Maps ticket values onto presentation, and answers the two questions every
 * control on this surface asks: *may this principal make this move*, and *does
 * it need confirming*.
 *
 * Kept out of the components so the queue row, the detail header and the status
 * control label a status identically — and so the transition rules are read from
 * the contract's own table in exactly one place.
 */

export const TICKET_STATUS_TONES: Record<TicketStatus, BadgeTone> = {
  open: 'info',
  // Waiting on the customer: paused work, not a problem to draw the eye to.
  pending: 'warning',
  resolved: 'success',
  closed: 'neutral',
};

/**
 * Urgent is `danger` rather than `warning` because `high` already holds the
 * warning tone, and the queue's whole point is that urgent reads differently
 * from everything below it at a glance. The label carries the meaning either
 * way — colour never conveys it alone.
 */
export const TICKET_PRIORITY_TONES: Record<TicketPriority, BadgeTone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
};

/**
 * The two statuses with no way back at v1: there is no reopen window, and
 * `TICKET_STATUS_TRANSITIONS` refuses every move out of `closed` and every move
 * out of `resolved` except into `closed`.
 *
 * The same set that needs `ticket:close`, and the same set the console confirms
 * before entering — one predicate rather than three, because they are one fact.
 */
export type TerminalTicketStatus = Extract<TicketStatus, 'resolved' | 'closed'>;

export function isTerminalStatus(status: TicketStatus): status is TerminalTicketStatus {
  return TICKET_STATUS_REQUIRES_CLOSE[status];
}

/**
 * The moves this principal may make out of `current`, read straight from
 * `TICKET_STATUS_TRANSITIONS` so the buttons the console offers and the
 * transitions the API accepts cannot drift.
 *
 * A principal without `ticket:close` has the terminal pair **omitted** rather
 * than disabled: a disabled control explains nothing from the other side of a
 * support call and is skipped by keyboard navigation, so the panel renders the
 * reason beside the row instead.
 */
export function statusMovesFor(current: TicketStatus, canClose: boolean): readonly TicketStatus[] {
  return TICKET_STATUS_TRANSITIONS[current].filter((next) => canClose || !isTerminalStatus(next));
}

export function priorityOptions(): SelectOption[] {
  return TICKET_PRIORITIES.map((priority) => ({
    value: priority,
    label: content.ticketPriorities[priority],
  }));
}

/**
 * True when the status has nowhere left to go for anybody — `closed`, whose row
 * in the transition table is empty. Distinct from "this principal has no moves",
 * which is the narrower `statusMovesFor(...).length === 0`: the two want
 * different copy, one about the ticket and one about the reader's role.
 */
export function isStatusFinal(current: TicketStatus): boolean {
  return TICKET_STATUS_TRANSITIONS[current].length === 0;
}

/**
 * What to call a ticket in a sentence, a row and a heading.
 *
 * `subject` is null on every auto-created ticket, so the per-tenant number is
 * the fallback rather than an exception — it is what agents and customers quote.
 * The contract suggests falling back to the contact's name; there is no contact
 * read on this surface to do that with, and inventing one per row would cost the
 * queue a request per ticket.
 */
export function ticketLabel(ticket: Pick<TicketResponse, 'subject' | 'number'>): string {
  return ticket.subject ?? content.tickets.untitled(ticket.number);
}

/**
 * Who holds the ticket: the person, else the team, else nobody.
 *
 * A name the reader's one page of the directory could not resolve still reports
 * "assigned to another agent" rather than "unassigned" — showing a held ticket as
 * free would send somebody to work that is already being done. Shared by the
 * queue row and the ticket header so the two cannot answer differently.
 *
 * The lookups are inline rather than `directory.data`'s `nameFor`: that module is
 * `server-only`, and this one is reached from a client component.
 */
export function assigneeLabelFor(
  ticket: Pick<TicketResponse, 'assignedUserId' | 'assignedTeamId'>,
  userNames: ReadonlyMap<string, string>,
  teamNames: ReadonlyMap<string, string>,
): string {
  if (ticket.assignedUserId !== null) {
    return userNames.get(ticket.assignedUserId) ?? content.inbox.assignedToUnresolved;
  }

  if (ticket.assignedTeamId !== null) {
    const teamName = teamNames.get(ticket.assignedTeamId);

    if (teamName !== undefined) {
      return content.inbox.assignedToTeam(teamName);
    }
  }

  return content.common.unassigned;
}
