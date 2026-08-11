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
}

export interface InboxQuery {
  scope: ConversationListQuery['scope'];
  status?: ConversationListQuery['status'];
}

export async function loadInbox(query: InboxQuery): Promise<InboxData> {
  const [conversations, directory] = await Promise.all([
    listConversations({
      scope: query.scope,
      status: query.status,
      limit: CONVERSATIONS_PAGE_SIZE,
    }),
    loadDirectory(),
  ]);

  return { conversations: conversations.items, ...directory };
}
