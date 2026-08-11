import 'server-only';

import {
  MessageTemplateResponseSchema,
  type CursorPage,
  type MessageTemplateListQuery,
  type MessageTemplateResponse,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';
import { parseCursorPage } from '@/lib/api/parse';

/**
 * The templates an agent may send (TAR-20a), which is the composer's only option
 * once the 24-hour service window has closed.
 *
 * The endpoint returns approved *and sendable* templates only — there is no
 * `status` filter to get anything else, by design. Two consequences the caller
 * has to know about:
 *
 *   * The sendable exclusion is applied to each page after it is read, so a page
 *     may hold fewer than `limit` items while `nextCursor` is non-null. Page
 *     until `nextCursor` is null; never stop by counting.
 *   * `whatsappAccountId` is a **phone number**, which is what a conversation
 *     publishes. The server resolves its WABA. Passing the WABA instead is the
 *     administrative read and is mutually exclusive with it.
 */

const MESSAGE_TEMPLATES_PATH = '/v1/message-templates';

export async function listMessageTemplates(
  query: MessageTemplateListQuery,
): Promise<CursorPage<MessageTemplateResponse>> {
  const params = new URLSearchParams({ limit: String(query.limit) });

  if (query.whatsappAccountId !== undefined) {
    params.set('whatsappAccountId', query.whatsappAccountId);
  }

  if (query.whatsappBusinessAccountId !== undefined) {
    params.set('whatsappBusinessAccountId', query.whatsappBusinessAccountId);
  }

  if (query.q !== undefined) {
    params.set('q', query.q);
  }

  if (query.cursor !== undefined) {
    params.set('cursor', query.cursor);
  }

  const response = await authenticatedRequest({
    method: 'GET',
    path: `${MESSAGE_TEMPLATES_PATH}?${params.toString()}`,
  });

  return parseCursorPage(MessageTemplateResponseSchema, response);
}
