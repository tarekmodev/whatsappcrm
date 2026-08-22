import type { TicketResponse } from '@whatsappcrm/contracts';
import type { ObservableSlaState } from '@/features/sla/presentation';
import type { TicketPriorityFilter, TicketStatusFilter } from '@/lib/routes';

/**
 * Which of a queue row's three marks are loud, and which are quiet (TAR-520).
 *
 * Pure mapping, no React, so the rule is testable on its own and no cell holds a
 * copy of it. `features/inbox/conversation-chips.ts` is the same idea for a
 * conversation row; the only difference is that a ticket row spreads its marks
 * across *columns* rather than into one chip slot.
 *
 * ## Why a budget
 *
 * 0001's status vocabulary caps a list row at one status chip. A ticket row is
 * three columns of state — priority, status, SLA — and drawing all three as
 * `Badge`s put `Urgent` `Open` `Overdue` on one row: three pills competing for
 * the same glance, none of them winning. The queue's whole job is that urgent
 * and late read differently from everything else on it.
 *
 * ## Quiet is not absent
 *
 * A losing mark is **not dropped** — its cell renders the same word as muted
 * text. That is what makes a budget safe in a table where the conversation row's
 * "just leave it out" would not be: a column header with nothing under it reads
 * as missing data, and below 40rem `DataTable` stacks each cell under a repeated
 * label, where an empty one is a labelled blank. The reader loses the emphasis,
 * never the fact.
 *
 * ## The order
 *
 * Most-actionable first, and it is a decision rather than the column order:
 *
 * 1. **A breached SLA.** Somebody is already late, and nothing else on the row
 *    outranks that. It is also the fact `DataTable`'s row tone draws a rule for,
 *    so demoting it would leave that rule as colour alone.
 * 2. **`urgent`, then `high` priority.** The queue is sorted by priority, so it
 *    is the answer to "why is this row where it is".
 * 3. **A status worth saying.** Never `open` — the ordinary state of a ticket in
 *    a queue, and a word on every row nobody gains anything from.
 * 4. **A running, paused or met SLA.** A timer that is simply running is the
 *    normal case; a queue where every row shouts cannot say that one is late.
 *
 * `normal` and `low` priority are never loud: both take the neutral tone, so the
 * pill would be a grey word repeated down the whole column.
 *
 * **Nothing the filter has already named is loud**, priority or status. 0001 is
 * explicit about it — "the column on the left has just said it" — and under
 * `?priority=high` a `High` pill on all six rows is six copies of the filter.
 */

/** The row's three columns of state, in the order they appear in the table. */
export type TicketMark = 'priority' | 'status' | 'sla';

/**
 * How many marks may be a `Badge` at once. Two rather than 0001's one, because a
 * ticket row answers two questions a conversation row does not have to — how
 * urgent, and how late — and folding them into a single slot would hide whichever
 * lost behind the one that won.
 */
export const TICKET_MARK_BUDGET = 2;

export type TicketMarkEmphasis = Readonly<Record<TicketMark, boolean>>;

/** The narrowing the queue is already showing on the left of the screen. */
export interface TicketMarkFilter {
  readonly status: TicketStatusFilter | undefined;
  readonly priority: TicketPriorityFilter | undefined;
}

/**
 * True per mark when its cell should render a `Badge`, false when it should
 * render muted text.
 *
 * `slaState` is the state the SLA cell is actually about to draw — the
 * first-response timer, per `ticket-columns.ts` — rather than the ticket's whole
 * SLA. `null` is a row with no timer to show, which spends none of the budget.
 */
export function ticketMarkEmphasis(
  ticket: Pick<TicketResponse, 'priority' | 'status'>,
  slaState: ObservableSlaState | null,
  filter: TicketMarkFilter,
): TicketMarkEmphasis {
  const ranked: TicketMark[] = [];

  if (slaState === 'breached') {
    ranked.push('sla');
  }

  if (
    (ticket.priority === 'urgent' || ticket.priority === 'high') &&
    ticket.priority !== filter.priority
  ) {
    ranked.push('priority');
  }

  if (ticket.status !== 'open' && ticket.status !== filter.status) {
    ranked.push('status');
  }

  if (slaState !== null && slaState !== 'breached') {
    ranked.push('sla');
  }

  const loud = new Set(ranked.slice(0, TICKET_MARK_BUDGET));

  return { priority: loud.has('priority'), status: loud.has('status'), sla: loud.has('sla') };
}
