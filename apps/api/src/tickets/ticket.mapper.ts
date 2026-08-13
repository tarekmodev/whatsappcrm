import type { TicketResponse, TicketSla } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * `tickets` → `TicketResponse`.
 *
 * ## The projection is the response, and nothing else
 *
 * One constant rather than a `select` per call site, for the same reason
 * `conversation.mapper.ts` states: the queue list, the detail read and the PATCH
 * that returns the resource all load exactly the columns the response publishes.
 * Three copies is how one of them quietly grows a `SELECT *`.
 *
 * Nothing relational is loaded. Every published field is a column on `tickets`,
 * so a 25-row page is one statement and no relation load — unlike the inbox,
 * which pays for the contact, the newest message and the active ticket. The
 * `breachedOnly` filter reaches `sla_timers`, but as a `where` predicate rather
 * than a selection: it decides which rows come back, never what is read off
 * them.
 *
 * ## `sla` is a fixed placeholder, and that is the whole of it today
 *
 * `TicketResponseSchema.sla` is required and non-nullable (0003, open question
 * 5) and there is no timer to fill it: `SlaTimer` rows are TAR-26's, and nothing
 * writes one yet. So this emits `not_applicable` on both targets with null dues
 * — the honest reading of "this ticket has no SLA policy attached" — rather than
 * inventing a `running` state for a timer that does not exist.
 *
 * TAR-26 replaces the placeholder with a real read of the ticket's timers. **The
 * response shape does not change when it does**, which is what makes this safe
 * to publish now instead of blocking the queue on the SLA story.
 *
 * ## `firstRespondedAt` is always null
 *
 * The column exists and nothing writes it; first-response tracking is TAR-26's
 * too. Emitting the column rather than a literal `null` is deliberate all the
 * same — the day something writes it, this file needs no edit.
 *
 * ## `routing` is read from the row, and nothing writes it yet either
 *
 * The three columns land with TAR-272 and are published by TAR-273. Their writer
 * is the router (TAR-288), so today every ticket reads `pending` — bar the ones
 * TAR-272's backfill classified `manual` — and TAR-274's
 * `?routingState=deferred` returns an empty page rather than a wrong one.
 *
 * Read from the row rather than stubbed, on the opposite reasoning to `sla`
 * above: there is a column here to read, and 0008 risk 6 names this mapper as
 * the thing that has to carry the field from the start rather than be
 * retrofitted once the router starts writing.
 */

/**
 * The SLA every ticket carries until TAR-26 attaches real timers.
 *
 * Built per call rather than shared as a frozen constant: it is handed out as
 * part of a response object a caller may serialise, log or mutate, and a
 * module-level object reachable from every ticket in a page is one shared
 * mutation away from changing all of them.
 */
function placeholderSla(): TicketSla {
  return {
    policyId: null,
    firstResponseState: 'not_applicable',
    firstResponseDueAt: null,
    resolutionState: 'not_applicable',
    resolutionDueAt: null,
  };
}

export const TICKET_PROJECTION = {
  id: true,
  number: true,
  conversationId: true,
  contactId: true,
  subject: true,
  status: true,
  priority: true,
  assignedUserId: true,
  assignedTeamId: true,
  routingState: true,
  routingDeferredReason: true,
  routingDeferredSince: true,
  firstRespondedAt: true,
  resolvedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TicketSelect;

export type TicketRow = Prisma.TicketGetPayload<{ select: typeof TICKET_PROJECTION }>;

export function toTicketResponse(ticket: TicketRow): TicketResponse {
  return {
    id: ticket.id,
    number: ticket.number,
    conversationId: ticket.conversationId,
    contactId: ticket.contactId,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    assignedUserId: ticket.assignedUserId,
    assignedTeamId: ticket.assignedTeamId,
    routing: {
      state: ticket.routingState,
      deferredReason: ticket.routingDeferredReason,
      deferredSince: ticket.routingDeferredSince?.toISOString() ?? null,
    },
    sla: placeholderSla(),
    firstRespondedAt: ticket.firstRespondedAt?.toISOString() ?? null,
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    closedAt: ticket.closedAt?.toISOString() ?? null,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}
