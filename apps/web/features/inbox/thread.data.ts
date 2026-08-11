import 'server-only';

import type {
  ConversationResponse,
  InternalNoteResponse,
  MessageResponse,
} from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { getConversation, listInternalNotes, listMessages } from '@/lib/api/conversations';
import { NOTES_PAGE_SIZE, THREAD_PAGE_SIZE } from '@/features/inbox/constants';
import { loadDirectory, type Directory } from '@/features/inbox/directory.data';

/**
 * One open conversation: the thread, its internal notes, and the names behind
 * the ids both carry.
 *
 * The three reads are concurrent. Each one applies the same visibility rule on
 * the API side, so a thread the caller may not see answers `not_found` from all
 * of them — there is nothing here that could half-render.
 *
 * ## `not_found` is an outcome, not a failure
 *
 * A thread the reader may not see is answered `not_found`, never `forbidden`, so
 * nothing can be enumerated across tenants or colleagues. Left to throw, that
 * became the generic "something went wrong" card with a Retry button that could
 * never succeed — on two flows this feature is built around: a supervisor
 * sharing `/inbox?scope=all&conversation=…` with an agent who cannot see it, and
 * a reader whose open thread is claimed by somebody else between refetches. It
 * is returned as a state so the pane can say what happened and leave the list
 * alone.
 */

export interface ConversationThreadData extends Directory {
  conversation: ConversationResponse;
  /**
   * Oldest first, which is reading order. The API pages a thread newest-first —
   * the first page of a two-year-old conversation has to be its *end* — so the
   * page is reversed here rather than asked for ascending.
   */
  messages: readonly MessageResponse[];
  /** True when the conversation has more than this one page behind it. */
  hasOlderMessages: boolean;
  /** Newest first, as the API returns them: a note panel reads top-down. */
  notes: readonly InternalNoteResponse[];
}

export type ConversationThreadResult =
  | { readonly outcome: 'ready'; readonly thread: ConversationThreadData }
  /** The id names nothing this reader may see. Not an error — an answer. */
  | { readonly outcome: 'unavailable' };

export async function loadConversationThread(
  conversationId: string,
): Promise<ConversationThreadResult> {
  try {
    const [conversation, messages, notes, directory] = await Promise.all([
      getConversation(conversationId),
      listMessages(conversationId, { limit: THREAD_PAGE_SIZE }),
      listInternalNotes(conversationId, { limit: NOTES_PAGE_SIZE }),
      loadDirectory(),
    ]);

    return {
      outcome: 'ready',
      thread: {
        conversation,
        messages: [...messages.items].reverse(),
        hasOlderMessages: messages.nextCursor !== null,
        notes: notes.items,
        ...directory,
      },
    };
  } catch (error) {
    // Narrow, deliberately. Everything else — a 502, a malformed response, and
    // the `redirect` a lost session throws, which is not an `ApiRequestError` —
    // belongs to the boundary above, and swallowing the redirect would leave the
    // user on a page they are no longer signed in to.
    if (error instanceof ApiRequestError && error.code === NOT_FOUND_CODE) {
      return { outcome: 'unavailable' };
    }

    throw error;
  }
}

const NOT_FOUND_CODE = 'not_found';
