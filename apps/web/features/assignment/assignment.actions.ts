'use server';

import { TicketAssignInputSchema } from '@whatsappcrm/contracts';
import { assignTicket } from '@/lib/api/tickets';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * Mutations for the assignment surface. One, for now: taking a ticket
 * auto-assignment could not place and putting a name on it.
 */

/** Path only — `routes.settingsAssignment()` may carry a reason filter. */
const ASSIGNMENT_PATH = routes.settingsAssignment().split('?')[0] ?? '/settings/assignment';

/**
 * `POST /tickets/{id}/assign`, behind `ticket:assign`.
 *
 * Not optimistic. The API's write also moves `routing.state` to `manual`, which is
 * what removes the row from this queue, and an optimistic version would have to
 * fake that transition and then unfake it on a refusal — showing a supervisor a
 * ticket leaving their queue when it did not is worse than a moment's pending
 * state.
 */
export async function assignFlaggedTicketAction(
  ticketId: string,
  input: unknown,
): Promise<ActionResult<{ ticketId: string }>> {
  return runAction({
    permission: 'ticket:assign',
    parser: TicketAssignInputSchema,
    input,
    revalidate: ASSIGNMENT_PATH,
    label: 'Assignment',
    perform: async (parsed) => {
      const ticket = await assignTicket(ticketId, parsed);

      return { ticketId: ticket.id };
    },
  });
}
