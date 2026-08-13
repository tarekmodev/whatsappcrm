'use server';

import {
  TICKET_STATUS_REQUIRES_CLOSE,
  TicketUpdateInputSchema,
  type TicketPriority,
  type TicketStatus,
} from '@whatsappcrm/contracts';
import { updateTicket } from '@/lib/api/tickets';
import { verifySession } from '@/lib/session/session';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { ActionRefusedError, runAction } from '@/lib/actions/run-action';
import { ticketLabel } from '@/features/tickets/presentation';

/**
 * The one write this surface makes: `PATCH /tickets/{id}`.
 *
 * One action rather than a status one and a priority one, because it is one
 * endpoint carrying one target state — and because splitting it would mean two
 * places to remember the `ticket:close` rule below. `runAction` owns the
 * assert / validate / revalidate / report sequence.
 */

/** Path only — `routes.tickets()` carries the scope, status and priority. */
const TICKETS_PATH = routes.tickets().split('?')[0] ?? '/tickets';

export interface TicketUpdateResult {
  readonly label: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
}

/**
 * Changes a ticket's status, its priority, or both.
 *
 * `ticket:update` is asserted by `runAction`; entering `resolved` or `closed`
 * additionally needs `ticket:close`, which is checked here rather than by the
 * guard because it is a property of the *body*, not of the route (ADR 0006 §7).
 * That refusal carries copy an agent can act on — "ask a supervisor to finish
 * it" — instead of the generic line a raw `PermissionDeniedError` would produce.
 *
 * A move the transition table refuses, and a compare-and-set that lost a race
 * with the customer's reply, both come back as `conflict` with the API's own
 * message naming the current status. `runAction` shows those verbatim: "somebody
 * replied while you were resolving this" is precisely what the agent needs.
 */
export async function updateTicketAction(
  ticketId: string,
  input: unknown,
): Promise<ActionResult<TicketUpdateResult>> {
  return runAction({
    permission: 'ticket:update',
    parser: TicketUpdateInputSchema,
    input,
    revalidate: TICKETS_PATH,
    label: 'Tickets',
    perform: async (parsed) => {
      if (parsed.status !== undefined && TICKET_STATUS_REQUIRES_CLOSE[parsed.status]) {
        const { checker } = await verifySession();

        if (!checker.can('ticket:close')) {
          throw new ActionRefusedError(content.tickets.closeNotPermitted);
        }
      }

      const ticket = await updateTicket(ticketId, parsed);

      return {
        label: ticketLabel(ticket),
        status: ticket.status,
        priority: ticket.priority,
      };
    },
  });
}
