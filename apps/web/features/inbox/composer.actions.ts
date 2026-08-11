'use server';

import {
  MessageTemplateListQuerySchema,
  SendMessageInputSchema,
  type CursorPage,
  type MessageTemplateResponse,
} from '@whatsappcrm/contracts';
import { getConversation } from '@/lib/api/conversations';
import { listMessageTemplates } from '@/lib/api/message-templates';
import { sendMessage } from '@/lib/api/messages';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * The composer's two calls: sending, and reading the templates it may send once
 * the service window has closed (TAR-20g).
 *
 * Separate from `inbox.actions.ts` because they are the surface that reaches the
 * customer. A note goes to the team and can be worded again; a send cannot be
 * recalled, which is why the idempotency key is a parameter here rather than
 * something a resource module invents.
 *
 * `runAction` owns the assert / validate / revalidate / report sequence.
 */

/** Path only — `routes.inbox()` carries the scope, status and open thread. */
const INBOX_PATH = routes.inbox().split('?')[0] ?? '/inbox';

/**
 * `POST /conversations/{id}/messages` — the reply the customer receives.
 *
 * `idempotencyKey` comes from the composer and is deliberately the caller's to
 * choose: it has to stay stable across a retry of the *same* draft and change
 * when the draft does, and only the thing holding the draft knows which is which
 * (`useIdempotencyKey`).
 *
 * The service window is **not** checked here. `SendMessageInputSchema` accepts
 * all three arms and the API decides, answering `whatsapp_window_expired` for a
 * free-form send outside the window. Re-deciding it on this side would mean two
 * clocks and two rules, and the console's would be the one that was wrong.
 */
export async function sendMessageAction(
  conversationId: string,
  idempotencyKey: string,
  input: unknown,
): Promise<ActionResult<undefined>> {
  return runAction({
    permission: 'conversation:send',
    parser: SendMessageInputSchema,
    input,
    revalidate: INBOX_PATH,
    label: 'Composer',
    perform: async (parsed) => {
      await sendMessage(conversationId, parsed, idempotencyKey);

      return undefined;
    },
  });
}

/**
 * `GET /message-templates` for the number this conversation is on — a read, so
 * it revalidates nothing.
 *
 * The phone number is resolved here from the conversation rather than taken from
 * the caller. A client could name any number, and while the API would refuse one
 * outside the tenant, one *inside* it would quietly list a sibling number's
 * templates — approved, sendable-looking, and refused at Meta because they
 * belong to a different WABA. The extra read is the price of the composer never
 * being able to ask that question.
 */
export async function listTemplatesAction(
  conversationId: string,
  input: unknown,
): Promise<ActionResult<CursorPage<MessageTemplateResponse>>> {
  return runAction({
    permission: 'conversation:send',
    parser: MessageTemplateListQuerySchema,
    input,
    revalidate: null,
    label: 'Composer templates',
    perform: async (parsed) => {
      const conversation = await getConversation(conversationId);

      return listMessageTemplates({
        ...parsed,
        whatsappAccountId: conversation.whatsappAccountId,
        // Mutually exclusive with the number, and never the composer's read.
        whatsappBusinessAccountId: undefined,
      });
    },
  });
}
