'use server';

import { TicketAssignInputSchema, UserUpdateInputSchema } from '@whatsappcrm/contracts';
import { assignTicket } from '@/lib/api/tickets';
import { updateUser } from '@/lib/api/users';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * Mutations for the assignment surface: taking a ticket auto-assignment could
 * not place and putting a name on it, and changing how much work one agent may
 * hold at once.
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

/**
 * The cap body, required rather than optional.
 *
 * `UserUpdateInputSchema` publishes `maxConcurrentTickets` as optional because a
 * `PATCH` may carry any subset of a user's fields. This action carries exactly
 * that field, so absent is not "leave it alone" — it is a client that failed to
 * send what it was asked for, and parsing it as a valid no-op would report
 * success for a write that never happened. `.required()` keeps `null` (clear the
 * override) and rejects only the absent case.
 *
 * Picked from the contract's own schema rather than restated, so the bound stays
 * `ASSIGNMENT_POLICY`'s single copy of 1–1000.
 */
const AgentCapacityUpdateSchema = UserUpdateInputSchema.pick({
  maxConcurrentTickets: true,
}).required();

/**
 * `PATCH /users/{id}`, behind `assignment_rule:write`.
 *
 * **Not `user:update`.** Deciding how much work reaches a colleague is the same
 * act as writing a routing rule (ADR 0008 decision 4): routing it through the
 * permission that edits a display name would let anyone who may rename somebody
 * also quietly stop work reaching them. The API enforces both; this asserts the
 * one that is actually about the cap.
 *
 * Not optimistic. The number a supervisor is acting on is a *live* count of
 * assigned tickets against a limit, and faking the transition would mean
 * inventing the new headroom before the server agreed to it — on a screen whose
 * entire purpose is telling them whether raising a limit will help.
 */
export async function updateAgentCapacityAction(
  userId: string,
  input: unknown,
): Promise<ActionResult<{ userId: string; maxConcurrentTickets: number | null }>> {
  return runAction({
    permission: 'assignment_rule:write',
    parser: AgentCapacityUpdateSchema,
    input,
    revalidate: ASSIGNMENT_PATH,
    label: 'Agent capacity',
    perform: async (parsed) => {
      const user = await updateUser(userId, { maxConcurrentTickets: parsed.maxConcurrentTickets });

      return { userId: user.id, maxConcurrentTickets: parsed.maxConcurrentTickets };
    },
  });
}
