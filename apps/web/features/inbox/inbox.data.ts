import 'server-only';

import type { ConversationListQuery, ConversationResponse } from '@whatsappcrm/contracts';
import { listConversations } from '@/lib/api/conversations';
import { listTeams } from '@/lib/api/teams';
import { listUsers } from '@/lib/api/users';
import { AGENTS_PAGE_SIZE, CONVERSATIONS_PAGE_SIZE } from '@/features/people/constants';

/**
 * The inbox read.
 *
 * The scope the caller *asked* for and the scope they actually got are both
 * returned, because the contract has the API silently narrow `scope` for a
 * principal without `conversation:read_all` — a supervisor's shared link still
 * renders for an agent, with less in it. The UI says so rather than leaving them
 * wondering why the list looks short.
 */

export interface InboxData {
  conversations: readonly ConversationResponse[];
  /** Resolved display names for assignees, so a row does not render a raw id. */
  assigneeNames: ReadonlyMap<string, string>;
  teamNames: ReadonlyMap<string, string>;
  /** True when the requested scope was wider than the principal may read. */
  wasScopeNarrowed: boolean;
}

export interface InboxQuery {
  requestedScope: ConversationListQuery['scope'];
  effectiveScope: ConversationListQuery['scope'];
  status?: ConversationListQuery['status'];
}

export async function loadInbox(query: InboxQuery): Promise<InboxData> {
  const [conversations, users, teams] = await Promise.all([
    listConversations({
      scope: query.effectiveScope,
      status: query.status,
      limit: CONVERSATIONS_PAGE_SIZE,
    }),
    // `user:read` and `team:read` are granted to every role, so an agent can also
    // resolve the names on their own rows.
    listUsers({ limit: AGENTS_PAGE_SIZE }),
    listTeams(),
  ]);

  return {
    conversations: conversations.items,
    assigneeNames: new Map(users.items.map((user) => [user.id, user.displayName])),
    teamNames: new Map(teams.items.map((team) => [team.id, team.name])),
    wasScopeNarrowed: query.requestedScope !== query.effectiveScope,
  };
}
