import 'server-only';

import {
  ConversationResponseSchema,
  InternalNoteResponseSchema,
  MessageResponseSchema,
  type ConversationAssignInput,
  type ConversationListQuery,
  type ConversationResponse,
  type CursorPage,
  type InternalNoteCreateInput,
  type InternalNoteResponse,
  type MessageListQuery,
  type MessageResponse,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';
import { parseCursorPage } from '@/lib/api/parse';

/**
 * The conversation resource, per TAR-39's endpoint table: the inbox list, one
 * thread, its messages, its internal notes, and the claim.
 *
 * Sending is deliberately absent — TAR-20g owns the composer and the
 * `Idempotency-Key` that `POST /conversations/{id}/messages` requires.
 */

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

  const response = await authenticatedRequest({
    method: 'GET',
    path: `${CONVERSATIONS_PATH}?${params.toString()}`,
  });

  return parseCursorPage(ConversationResponseSchema, response);
}

/**
 * `GET /api/v1/conversations/{id}`.
 *
 * A thread the caller may not see answers `not_found`, never `forbidden` — the
 * two are indistinguishable by design, so an id cannot be used to find out
 * whether a colleague is handling something.
 */
export async function getConversation(conversationId: string): Promise<ConversationResponse> {
  const response = await authenticatedRequest({
    method: 'GET',
    path: `${CONVERSATIONS_PATH}/${conversationId}`,
  });

  return ConversationResponseSchema.parse(response);
}

/**
 * `GET /api/v1/conversations/{id}/messages`.
 *
 * `desc` is the API's default and the one the inbox wants: a thread is read from
 * the newest message backwards, so the *first* page is the last thirty messages.
 * The view reverses them for display rather than asking for `asc`, which would
 * page from the beginning of a two-year-old conversation.
 */
export async function listMessages(
  conversationId: string,
  query: Pick<MessageListQuery, 'limit'>,
): Promise<CursorPage<MessageResponse>> {
  const params = new URLSearchParams({ order: 'desc', limit: String(query.limit) });

  const response = await authenticatedRequest({
    method: 'GET',
    path: `${CONVERSATIONS_PATH}/${conversationId}/messages?${params.toString()}`,
  });

  return parseCursorPage(MessageResponseSchema, response);
}

/** `GET /api/v1/conversations/{id}/notes` — newest first. */
export async function listInternalNotes(
  conversationId: string,
  query: { limit: number },
): Promise<CursorPage<InternalNoteResponse>> {
  const params = new URLSearchParams({ limit: String(query.limit) });

  const response = await authenticatedRequest({
    method: 'GET',
    path: `${CONVERSATIONS_PATH}/${conversationId}/notes?${params.toString()}`,
  });

  return parseCursorPage(InternalNoteResponseSchema, response);
}

/**
 * `POST /api/v1/conversations/{id}/notes`.
 *
 * The author is the session's principal and is never sent: a note is a statement
 * about who said what, and a client that could name the speaker would make the
 * whole record worthless.
 */
export async function createInternalNote(
  conversationId: string,
  input: InternalNoteCreateInput,
): Promise<InternalNoteResponse> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: `${CONVERSATIONS_PATH}/${conversationId}/notes`,
    body: input,
  });

  return InternalNoteResponseSchema.parse(response);
}

/**
 * `POST /api/v1/conversations/{id}/assign` — claim, route to a team, or release.
 *
 * Absent leaves a column alone, `null` clears it, an id sets it. Releasing both
 * is what puts a thread back in `scope=unassigned`, where every agent sees it.
 */
export async function assignConversation(
  conversationId: string,
  input: ConversationAssignInput,
): Promise<ConversationResponse> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: `${CONVERSATIONS_PATH}/${conversationId}/assign`,
    body: input,
  });

  return ConversationResponseSchema.parse(response);
}
