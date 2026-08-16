'use server';

import {
  TicketAssignInputSchema,
  TicketEscalateInputSchema,
  ticketAssignRequiresReason,
} from '@whatsappcrm/contracts';
import { assignTicket, escalateTicket, getTicket } from '@/lib/api/tickets';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { ActionRefusedError, runAction } from '@/lib/actions/run-action';

/**
 * The two writes the handoff card makes: `POST /tickets/{id}/assign` and
 * `POST /tickets/{id}/escalate` (TAR-32, ADR 0011).
 *
 * Separate from `tickets.actions.ts` because they are separate endpoints under
 * separate permissions, and folding them in would put four unrelated refusals
 * behind one function. `runAction` owns the assert / validate / revalidate /
 * report sequence for both.
 *
 * Neither is optimistic. A reassignment moves the ticket out of this agent's
 * scope — the detail page may stop being readable to them the moment it lands —
 * and an escalation's whole answer is *who was told*, which the console cannot
 * predict. Showing either before the server agreed would be a success that did
 * not happen.
 */

/** Path only — `routes.ticket()` takes no query string, but the queue's does. */
const TICKETS_PATH = routes.tickets().split('?')[0] ?? '/tickets';

export interface TicketReassignResult {
  readonly ticketId: string;
  readonly assignedUserId: string | null;
}

/**
 * Hands a ticket to a teammate, with a reason.
 *
 * `ticket:handoff` is asserted by `runAction` — the weaker of the two
 * permissions, matching the route. The bound that `ticket:assign` skips (you
 * hold it, the target is a teammate, somebody still holds it afterwards) is the
 * API's, and its refusal is a `forbidden` whose message `runAction` shows
 * verbatim, because it names something the agent can act on.
 *
 * The conditional reason rule is re-checked here against the ticket's *current*
 * state rather than trusted from the client. A server action is a public
 * endpoint: the dialog cannot submit without a reason, and that is UX, not a
 * gate. Reading the ticket to apply `ticketAssignRequiresReason` costs one call
 * and is what keeps the console's copy of the rule honest — the alternative is a
 * `validation_failed` from the API whose message says less than this one.
 */
export async function reassignTicketAction(
  ticketId: string,
  input: unknown,
): Promise<ActionResult<TicketReassignResult>> {
  return runAction({
    permission: 'ticket:handoff',
    parser: TicketAssignInputSchema,
    input,
    revalidate: TICKETS_PATH,
    label: 'Ticket handoff',
    perform: async (parsed) => {
      if (parsed.reason === undefined) {
        const current = await getTicket(ticketId);

        if (ticketAssignRequiresReason(current)) {
          throw new ActionRefusedError(content.tickets.reasonRequiredError);
        }
      }

      const ticket = await assignTicket(ticketId, parsed);

      return { ticketId: ticket.id, assignedUserId: ticket.assignedUserId };
    },
  });
}

export interface TicketEscalationResult {
  readonly ticketId: string;
  /**
   * How many people an alert row was written for. **Zero is a real outcome** —
   * a tenant with no active supervisor still gets the escalation recorded — and
   * the dialog says so rather than showing a green tick (ADR 0011 decision 3).
   */
  readonly notifiedCount: number;
}

/**
 * Asks a supervisor to look at a ticket, without moving the assignment.
 *
 * `reason` is unconditionally required, and the schema carries that — unlike the
 * assign rule there is nothing about the row to consult, so a missing one is
 * refused by `TicketEscalateInputSchema` before the API is reached.
 *
 * Revalidates the queue path rather than nothing: the escalation writes a
 * history entry, and the ticket page is `force-dynamic`, so the panel below the
 * dialog re-renders with the new entry in it instead of going stale until the
 * next navigation.
 */
export async function escalateTicketAction(
  ticketId: string,
  input: unknown,
): Promise<ActionResult<TicketEscalationResult>> {
  return runAction({
    permission: 'ticket:escalate',
    parser: TicketEscalateInputSchema,
    input,
    revalidate: TICKETS_PATH,
    label: 'Ticket escalation',
    perform: async (parsed) => {
      const escalation = await escalateTicket(ticketId, parsed);

      return {
        ticketId: escalation.event.ticketId,
        notifiedCount: escalation.notifiedUserIds.length,
      };
    },
  });
}
