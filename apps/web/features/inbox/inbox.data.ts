import 'server-only';

import type { ConversationListQuery, ConversationResponse } from '@whatsappcrm/contracts';
import { listConversations } from '@/lib/api/conversations';
import { CONVERSATIONS_PAGE_SIZE } from '@/features/people/constants';
import { loadDirectory, type Directory } from '@/features/inbox/directory.data';

/**
 * The inbox read.
 *
 * `wasScopeNarrowed` is decided by the caller from the principal's permissions
 * rather than by comparing a requested scope with an effective one, because the
 * console no longer narrows: every role may ask for every scope, and the API
 * narrows `all` for a principal without `conversation:read_all` instead of
 * refusing it. The UI says so rather than leaving them wondering why the list
 * looks short.
 */

export interface InboxData extends Directory {
  conversations: readonly ConversationResponse[];
  /**
   * There is a page after this one, so the column header says "25+" rather than
   * claiming a total it was never given.
   *
   * Derived from the cursor rather than from a count: the list read is
   * deliberately built without a `count(*)` over a table that is appended to
   * continuously (`conversation-query.service.ts`), and `take: limit + 1` is the
   * only "is there more" this endpoint answers.
   */
  hasMore: boolean;
}

export interface InboxQuery {
  scope: ConversationListQuery['scope'];
  status?: ConversationListQuery['status'];
  /** The top bar's search term. Filters within the scope, never across it. */
  q?: ConversationListQuery['q'];
  /** The order the agent picked in the column header, from the URL. */
  sort: ConversationListQuery['sort'];
}

export async function loadInbox(query: InboxQuery): Promise<InboxData> {
  const [conversations, directory] = await Promise.all([
    listConversations({
      scope: query.scope,
      status: query.status,
      q: query.q,
      sort: query.sort,
      limit: CONVERSATIONS_PAGE_SIZE,
    }),
    loadDirectory(),
  ]);

  return {
    conversations: conversations.items,
    hasMore: conversations.nextCursor !== null,
    ...directory,
  };
}
