import type { SlaState, TicketResponse, TicketSla } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import type { SlaTimerState } from '../generated/prisma/enums';

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
 * Every published field is a column on `tickets` **except the SLA block**, which
 * is derived from the ticket's `sla_timers` rows — see below. The `breachedOnly`
 * filter reaches the same table, but as a `where` predicate rather than a
 * selection: it decides which rows come back, never what is read off them.
 *
 * ## `sla` is derived from the timers, never stored on the ticket
 *
 * TAR-284 published this mapper with a fixed `not_applicable` placeholder and
 * said in as many words that TAR-26 would replace it with a real read, and that
 * **the response shape does not change when it does**. This is that
 * replacement, and the shape did not change.
 *
 * ADR 0006 is explicit that no deadline or overdue flag is copied onto
 * `tickets`: `due_at` moves on every pause and resume, so a copy would be a
 * second source of truth whose drift produces a *false* breach — worse than a
 * late one. The timers are the authority, and this reads them.
 *
 * **The cost, stated because the placeholder had none:** this adds one bounded
 * relation load, so TAR-284's "nothing relational is loaded" no longer holds.
 * `UNIQUE (tenant_id, ticket_id, kind)` caps it at two rows per ticket and
 * serves the read, and Prisma resolves a relation load as one extra statement
 * per *page* rather than one per row — so a 25-row queue page is two statements,
 * not twenty-six.
 *
 * `cancelled` maps to `not_applicable` with a null deadline rather than to a
 * state of its own. The published `SLA_STATES` has no `cancelled`, and a ticket
 * closed unresolved has no SLA to render — "there is no deadline here" is what a
 * badge needs to know, and `not_applicable` says exactly that.
 *
 * ## `firstRespondedAt` carries a real value now
 *
 * TAR-284 shipped this field reading always-null, because nothing wrote the
 * column. `SlaTimerService` writes it the first time a person replies on the
 * ticket's conversation — the same event that stops the first-response timer —
 * so it now carries a value, and needed no edit here, exactly as that docblock
 * predicted.
 *
 * ## `routing` is read from the row, and nothing writes it yet
 *
 * The three columns land with TAR-272 and are published by TAR-273. Their writer
 * is the router (TAR-288), so today every ticket reads `pending` — bar the ones
 * TAR-272's backfill classified `manual` — and TAR-274's
 * `?routingState=deferred` returns an empty page rather than a wrong one.
 *
 * Plain columns rather than a derived block, so unlike `sla` above this costs no
 * relation load. 0008 risk 6 names this mapper as the thing that has to carry
 * the field from the start rather than be retrofitted once the router starts
 * writing — which is the same bet the `firstRespondedAt` paragraph above just
 * won.
 */

/** The timer states a deadline is worth publishing for. */
const STATE_MAP: Record<SlaTimerState, SlaState> = {
  running: 'running',
  paused: 'paused',
  met: 'met',
  breached: 'breached',
  cancelled: 'not_applicable',
};

export const TICKET_SLA_TIMER_PROJECTION = {
  kind: true,
  state: true,
  dueAt: true,
  policyId: true,
} as const satisfies Prisma.SlaTimerSelect;

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
  slaTimers: { select: TICKET_SLA_TIMER_PROJECTION },
} as const satisfies Prisma.TicketSelect;

export type TicketRow = Prisma.TicketGetPayload<{ select: typeof TICKET_PROJECTION }>;
type TicketSlaTimerRow = Prisma.SlaTimerGetPayload<{
  select: typeof TICKET_SLA_TIMER_PROJECTION;
}>;

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
    sla: toTicketSla(ticket.slaTimers),
    firstRespondedAt: ticket.firstRespondedAt?.toISOString() ?? null,
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    closedAt: ticket.closedAt?.toISOString() ?? null,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

/**
 * The two timers, as the queue badge reads them.
 *
 * `policyId` is the policy the timers were started under, taken from whichever
 * timer exists — both are created in one transaction from one resolution, so
 * they never disagree. Null when the ticket has no timers at all, which is the
 * honest answer for a tenant that has turned SLA off, and is the same value the
 * placeholder published for every ticket.
 */
export function toTicketSla(timers: readonly TicketSlaTimerRow[]): TicketSla {
  const firstResponse = timers.find((timer) => timer.kind === 'first_response');
  const resolution = timers.find((timer) => timer.kind === 'resolution');

  return {
    policyId: firstResponse?.policyId ?? resolution?.policyId ?? null,
    firstResponseState: toSlaState(firstResponse),
    firstResponseDueAt: toSlaDueAt(firstResponse),
    resolutionState: toSlaState(resolution),
    resolutionDueAt: toSlaDueAt(resolution),
  };
}

function toSlaState(timer: TicketSlaTimerRow | undefined): SlaState {
  return timer === undefined ? 'not_applicable' : STATE_MAP[timer.state];
}

/**
 * The deadline, or null wherever the state is `not_applicable` — an absent timer
 * and a cancelled one alike. Publishing a deadline beside "not applicable" would
 * invite a client to render a countdown against a clock that stopped.
 */
function toSlaDueAt(timer: TicketSlaTimerRow | undefined): string | null {
  return timer === undefined || timer.state === 'cancelled' ? null : timer.dueAt.toISOString();
}
