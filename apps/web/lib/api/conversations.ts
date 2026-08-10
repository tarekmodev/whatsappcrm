import 'server-only';

import {
  ConversationResponseSchema,
  type ConversationListQuery,
  type ConversationResponse,
  type CursorPage,
} from '@whatsappcrm/contracts';
import { apiRequest } from '@/lib/api/http';
import { parseCursorPage } from '@/lib/api/parse';

/** `GET /api/v1/conversations`, per TAR-39's endpoint table. */

const CONVERSATIONS_PATH = '/v1/conversations';

export async function listConversations(
  query: ConversationListQuery,
): Promise<CursorPage<ConversationResponse>> {
  const params = new URLSearchParams({ scope: query.scope, limit: String(query.limit) });

  if (query.status !== undefined) {
    params.set('status', query.status);
  }

  if (query.assignedUserId !== undefined) {
    params.set('assignedUserId', query.assignedUserId);
  }

  if (query.assignedTeamId !== undefined) {
    params.set('assignedTeamId', query.assignedTeamId);
  }

  if (query.q !== undefined) {
    params.set('q', query.q);
  }

  const response = await apiRequest({
    method: 'GET',
    path: `${CONVERSATIONS_PATH}?${params.toString()}`,
  });

  return parseCursorPage(ConversationResponseSchema, response);
}
