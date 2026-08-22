import 'server-only';

import {
  CONVERSATION_SORT_DEFAULT,
  type ConversationResponse,
  type TeamResponse,
  type UserResponse,
} from '@whatsappcrm/contracts';
import { listConversations } from '@/lib/api/conversations';
import { listTeams } from '@/lib/api/teams';
import { listUsers } from '@/lib/api/users';
import { AGENTS_PAGE_SIZE, CONVERSATIONS_PAGE_SIZE } from '@/features/people/constants';

/**
 * The supervisor's reporting read: every agent and team in *their* tenant, with
 * the open workload attributed to each.
 *
 * `scope: 'all'` is what makes this a supervisor surface — the API narrows that to
 * `assigned` for a caller without `conversation:read_all`, so the same code cannot
 * hand an agent a tenant-wide report. Tenant scoping is the API's, from the
 * session; there is no tenant parameter to get wrong here.
 */

export interface AgentLoadRow {
  user: UserResponse;
  openCount: number;
  unreadCount: number;
}

export interface TeamLoadRow {
  team: TeamResponse;
  openCount: number;
  unreadCount: number;
}

export interface AssignmentReport {
  agentRows: readonly AgentLoadRow[];
  teamRows: readonly TeamLoadRow[];
  unassigned: readonly ConversationResponse[];
}

export async function loadAssignmentReport(): Promise<AssignmentReport> {
  const [users, teams, conversations, unassigned] = await Promise.all([
    listUsers({ limit: AGENTS_PAGE_SIZE }),
    listTeams(),
    // The default order. This page counts and lists the shared pool rather than
    // triaging it, so there is nothing here for an agent to re-order.
    listConversations({
      scope: 'all',
      sort: CONVERSATION_SORT_DEFAULT,
      limit: CONVERSATIONS_PAGE_SIZE,
    }),
    listConversations({
      scope: 'unassigned',
      sort: CONVERSATION_SORT_DEFAULT,
      limit: CONVERSATIONS_PAGE_SIZE,
    }),
  ]);

  return {
    agentRows: users.items.map((user) => ({
      user,
      ...tally(conversations.items, (conversation) => conversation.assignedUserId === user.id),
    })),
    teamRows: teams.items.map((team) => ({
      team,
      ...tally(conversations.items, (conversation) => conversation.assignedTeamId === team.id),
    })),
    unassigned: unassigned.items,
  };
}

const OPEN_STATUSES = new Set<ConversationResponse['status']>(['open', 'pending']);

function tally(
  conversations: readonly ConversationResponse[],
  belongsHere: (conversation: ConversationResponse) => boolean,
): { openCount: number; unreadCount: number } {
  let openCount = 0;
  let unreadCount = 0;

  for (const conversation of conversations) {
    if (!belongsHere(conversation)) {
      continue;
    }

    if (OPEN_STATUSES.has(conversation.status)) {
      openCount += 1;
    }

    unreadCount += conversation.unreadCount;
  }

  return { openCount, unreadCount };
}
