import 'server-only';

import type {
  ConversationResponse,
  InternalNoteResponse,
  MessageResponse,
} from '@whatsappcrm/contracts';
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

export async function loadConversationThread(
  conversationId: string,
): Promise<ConversationThreadData> {
  const [conversation, messages, notes, directory] = await Promise.all([
    getConversation(conversationId),
    listMessages(conversationId, { limit: THREAD_PAGE_SIZE }),
    listInternalNotes(conversationId, { limit: NOTES_PAGE_SIZE }),
    loadDirectory(),
  ]);

  return {
    conversation,
    messages: [...messages.items].reverse(),
    hasOlderMessages: messages.nextCursor !== null,
    notes: notes.items,
    ...directory,
  };
}
