'use server';

import { InternalNoteCreateInputSchema } from '@whatsappcrm/contracts';
import { assignConversation, claimConversation, createInternalNote } from '@/lib/api/conversations';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * The two writes the shared inbox makes: who holds a conversation, and what the
 * team says to each other about it. Sending is TAR-20g's.
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
