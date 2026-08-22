'use server';

import { InternalNoteCreateInputSchema, type ConversationStatus } from '@whatsappcrm/contracts';
import { requestHandoff } from '@/lib/api/ai';
import {
  assignConversation,
  claimConversation,
  createInternalNote,
  setConversationStatus,
} from '@/lib/api/conversations';
import { verifySession } from '@/lib/session/session';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * The two writes the shared inbox makes: who holds a conversation, and what the
 * team says to each other about it. Sending is TAR-20g's.
 *
 * The first of those is three actions, not one, because since TAR-186 the three
 * directions are three different writes: a **claim** compares and sets and is
 * every role's, a **take-over** writes unconditionally and is a supervisor's, and
 * a **release** clears both columns. Collapsing any two of them was the bug —
 * pointing the take-over at the claim made every hand-over fail with "somebody
 * else claimed this", which is the claim's refusal doing its job on the one
 * caller it must not.
 *
 * `runAction` owns the assert / validate / revalidate / report sequence.
 */

/** Path only — `routes.inbox()` carries the scope, status and open thread. */
const INBOX_PATH = routes.inbox().split('?')[0] ?? '/inbox';

/**
 * Takes the conversation for the signed-in user.
 *
 * The assignee is the session's own principal and is never a parameter: a claim
 * that could name somebody else is a re-assignment, which is a different action
 * with a different confirmation. `teamId` is left alone — a thread routed to
 * Billing and picked up by one of its members is still Billing's.
 *
 * `conversation:claim` since TAR-186, and every role holds it: an inbox whose
 * arriving work every agent can read and none can take is not a shared inbox.
 * The API compares and sets, so the colleague who was a moment quicker keeps the
 * thread and this action reports their conflict rather than overwriting them —
 * which is also why the reply box stays shut until the claim comes back.
 */
export async function claimConversationAction(
  conversationId: string,
): Promise<ActionResult<{ contactName: string }>> {
  return runAction({
    permission: 'conversation:claim',
    parser: null,
    input: undefined,
    revalidate: INBOX_PATH,
    label: 'Inbox',
    perform: async () => {
      const conversation = await claimConversation(conversationId);

      return { contactName: conversation.contact.displayName };
    },
  });
}

/**
 * Takes the conversation **off the colleague handling it**.
 *
 * The same destination as a claim and a different write, which is the whole
 * reason it is a second action rather than the same one behind a confirmation.
 * The claim is a compare-and-set the API refuses for a thread somebody holds —
 * that refusal is what stops two agents both taking work out of the shared pool,
 * and it is exactly the refusal a take-over must not meet. So this one goes
 * through `assign`, which writes unconditionally, and pays for that with
 * `conversation:assign` and the confirmation in front of it.
 *
 * `teamId` is untouched: taking a Billing thread over does not remove it from
 * Billing.
 */
export async function takeOverConversationAction(
  conversationId: string,
): Promise<ActionResult<{ contactName: string }>> {
  return runAction({
    permission: 'conversation:assign',
    parser: null,
    input: undefined,
    revalidate: INBOX_PATH,
    label: 'Inbox',
    perform: async () => {
      const session = await verifySession();
      const conversation = await assignConversation(conversationId, {
        userId: session.principal.userId,
      });

      return { contactName: conversation.contact.displayName };
    },
  });
}

/**
 * Puts the conversation back in the shared pool.
 *
 * Both columns are cleared, because clearing only the assignee would leave a
 * thread routed to a team and therefore still invisible to everyone outside it —
 * "released" has to mean `scope=unassigned`, where every agent can see it again.
 */
export async function releaseConversationAction(
  conversationId: string,
): Promise<ActionResult<{ contactName: string }>> {
  return runAction({
    permission: 'conversation:assign',
    parser: null,
    input: undefined,
    revalidate: INBOX_PATH,
    label: 'Inbox',
    perform: async () => {
      const conversation = await assignConversation(conversationId, {
        userId: null,
        teamId: null,
      });

      return { contactName: conversation.contact.displayName };
    },
  });
}

/**
 * Closes an open conversation, or reopens a closed one.
 *
 * One action for both directions rather than two, because it is one write with a
 * different value — and because that is what makes closing reversible in a click
 * instead of an act needing a confirmation in front of it. The caller decides
 * which way; `ConversationStatus` is the contract's own union, so a third value
 * is a compile error rather than a 422.
 *
 * `conversation:read`, matching the endpoint: what gates this is the hold, not
 * the role. The API refuses a status change on a thread nobody has claimed, the
 * same way it refuses a send and a note (TAR-186), so the control is not offered
 * on an unclaimed thread either.
 */
export async function setConversationStatusAction(
  conversationId: string,
  status: ConversationStatus,
): Promise<ActionResult<{ contactName: string }>> {
  return runAction({
    permission: 'conversation:read',
    parser: null,
    input: undefined,
    revalidate: INBOX_PATH,
    label: 'Inbox',
    perform: async () => {
      const conversation = await setConversationStatus(conversationId, { status });

      return { contactName: conversation.contact.displayName };
    },
  });
}

/**
 * Takes a conversation off the **chatbot** (TAR-28).
 *
 * A third destination for "who is handling this", and a different write again:
 * the claim and the take-over both move `assignedUserId`, while this one moves
 * `bot_state` and leaves the assignment alone. A thread the chatbot is on may
 * already be routed to a team, and stopping the bot is not a decision about who
 * on that team answers.
 *
 * `conversation:claim`, matching the endpoint: taking work the chatbot is doing
 * is the same act as taking work nobody is doing, and every role holds it.
 *
 * **Idempotent by design.** A conversation already handed off — or already held
 * by a human — answers `200` with the current record and writes nothing, so a
 * double-click is a no-op rather than a `409`. That is the API's guarantee, not
 * this action's: the console still disables the control while one is in flight.
 */
export async function takeOverFromBotAction(
  conversationId: string,
): Promise<ActionResult<{ contactName: string }>> {
  return runAction({
    permission: 'conversation:claim',
    parser: null,
    input: undefined,
    revalidate: INBOX_PATH,
    label: 'Inbox',
    perform: async () => {
      const conversation = await requestHandoff(conversationId);

      return { contactName: conversation.contact.displayName };
    },
  });
}

/**
 * Adds an internal note — visible to agents, never sent to the customer.
 *
 * Notes are a separate entity from messages precisely so no send path can pick
 * one up by accident, and this action reaches `POST /conversations/{id}/notes`
 * only. There is no branch here that could reach a send.
 */
export async function addInternalNoteAction(
  conversationId: string,
  input: unknown,
): Promise<ActionResult<undefined>> {
  return runAction({
    permission: 'conversation:note',
    parser: InternalNoteCreateInputSchema,
    input,
    revalidate: INBOX_PATH,
    label: 'Inbox',
    perform: async (parsed) => {
      await createInternalNote(conversationId, parsed);

      return undefined;
    },
  });
}
