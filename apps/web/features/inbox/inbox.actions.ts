'use server';

import { InternalNoteCreateInputSchema } from '@whatsappcrm/contracts';
import { assignConversation, createInternalNote } from '@/lib/api/conversations';
import { verifySession } from '@/lib/session/session';
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
 * ⚠️ `conversation:assign` is **supervisor and above**. ADR 0002 amendment 4
 * opens an unclaimed conversation to every agent to read and rules that taking
 * one still needs this permission; ADR 0004 open item 2 records the
 * `conversation:claim` that would change that. The button is hidden for a
 * principal without it, and this assertion is why hiding it is not the gate.
 */
export async function claimConversationAction(
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
