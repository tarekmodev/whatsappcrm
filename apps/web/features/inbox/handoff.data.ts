import 'server-only';

import { cache } from 'react';
import { hasBotEngaged, type HandoffContextResponse } from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { getHandoffContext } from '@/lib/api/ai';
import { loadConversationThread } from '@/features/inbox/thread.data';

/**
 * What the chatbot did before it let go of one conversation (TAR-28 AC2).
 *
 * ## `not_found` is an outcome, not a failure
 *
 * `GET …/handoff` answers `404` for three different facts: no such conversation,
 * one this principal may not see, and one that has never handed off. They are
 * indistinguishable on purpose — the rest of the inbox uses the same rule, and a
 * `403` would confirm a conversation exists. Left to throw, the third case would
 * turn the ordinary "the chatbot was never here" state into an error card with a
 * Retry button that could never succeed. It is returned as a state instead.
 *
 * ## The request is skipped when it could only 404
 *
 * `botState === 'off'` means the chatbot never engaged — a tenant with no bot,
 * or a turn the gate refused silently — and the endpoint has nothing to answer.
 * Deciding that from the conversation the thread already loaded costs no round
 * trip; asking anyway would spend one to learn something the console already
 * knows.
 */

export type HandoffResult =
  | { readonly outcome: 'ready'; readonly handoff: HandoffContextResponse }
  /** The chatbot has not handed this conversation over. Not an error — an answer. */
  | { readonly outcome: 'none' };

/**
 * Request-cached like the thread read beside it, so the context panel and
 * anything else that asks are one request rather than two.
 */
export const loadHandoff = cache(async function loadHandoff(
  conversationId: string,
): Promise<HandoffResult> {
  const thread = await loadConversationThread(conversationId);

  if (thread.outcome === 'unavailable' || !hasBotEngaged(thread.thread.conversation.botState)) {
    return { outcome: 'none' };
  }

  try {
    return { outcome: 'ready', handoff: await getHandoffContext(conversationId) };
  } catch (error) {
    // Narrow, deliberately. Everything else — a 502, a malformed response, and
    // the `redirect` a lost session throws, which is not an `ApiRequestError` —
    // belongs to the boundary above, and swallowing the redirect would leave the
    // user on a page they are no longer signed in to.
    if (error instanceof ApiRequestError && error.code === NOT_FOUND_CODE) {
      return { outcome: 'none' };
    }

    throw error;
  }
});

const NOT_FOUND_CODE = 'not_found';
