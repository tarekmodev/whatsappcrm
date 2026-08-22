import 'server-only';

import {
  AiConfigResponseSchema,
  ConversationResponseSchema,
  HandoffContextResponseSchema,
  KnowledgeDocumentListItemSchema,
  KnowledgeDocumentResponseSchema,
  type AiConfigResponse,
  type ConversationResponse,
  type CreateKnowledgeDocumentInput,
  type CursorPage,
  type HandoffContextResponse,
  type KnowledgeDocumentListItem,
  type KnowledgeDocumentListQuery,
  type KnowledgeDocumentResponse,
  type UpdateAiConfigInput,
  type UpdateKnowledgeDocumentInput,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';
import { parseCursorPage } from '@/lib/api/parse';

/**
 * The AI chatbot surface, per ADR 0010's endpoint table: knowledge-base CRUD,
 * the per-tenant configuration, and the handoff a conversation carries.
 *
 * Three of these behave in ways a caller has to know about, and each is the
 * design's decision rather than this module's:
 *
 *   * **A write is asynchronous in exactly one respect.** `POST` and a
 *     content-changing `PATCH` come back with `status: 'pending'` and the
 *     document is not retrievable by the bot until indexing commits. The console
 *     renders the pending state; that is the honest thing to show, and it is why
 *     `chunkCount` is on the response.
 *   * **`GET /ai/config` is readable without the plan feature**, answering
 *     `isEnabled: false` with blocker `feature_not_in_plan`, so the console can
 *     render an upsell instead of a 403 page. `PATCH` is refused.
 *   * **`GET …/handoff` answers `404` for a conversation that has never handed
 *     off**, and the same `404` for one this principal may not see. The two are
 *     indistinguishable on purpose — the rest of the inbox uses the same rule —
 *     so callers treat "no handoff" as an outcome rather than as a failure.
 */

const KNOWLEDGE_DOCUMENTS_PATH = '/v1/knowledge-documents';
const AI_CONFIG_PATH = '/v1/ai/config';
const CONVERSATIONS_PATH = '/v1/conversations';

export async function listKnowledgeDocuments(
  query: KnowledgeDocumentListQuery,
): Promise<CursorPage<KnowledgeDocumentListItem>> {
  const params = new URLSearchParams({ limit: String(query.limit) });

  if (query.cursor !== undefined) {
    params.set('cursor', query.cursor);
  }

  if (query.status !== undefined) {
    params.set('status', query.status);
  }

  if (query.q !== undefined) {
    params.set('q', query.q);
  }

  const response = await authenticatedRequest({
    method: 'GET',
    path: `${KNOWLEDGE_DOCUMENTS_PATH}?${params.toString()}`,
  });

  return parseCursorPage(KnowledgeDocumentListItemSchema, response);
}

/**
 * `GET /api/v1/knowledge-documents/{id}` — the only read that carries `content`.
 *
 * The list omits it deliberately: a page of documents each holding up to 256 KiB
 * is a response nobody wants, so the editor fetches the one it is about to open.
 */
export async function getKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentResponse> {
  return KnowledgeDocumentResponseSchema.parse(
    await authenticatedRequest({
      method: 'GET',
      path: `${KNOWLEDGE_DOCUMENTS_PATH}/${documentId}`,
    }),
  );
}

export async function createKnowledgeDocument(
  input: CreateKnowledgeDocumentInput,
): Promise<KnowledgeDocumentResponse> {
  return KnowledgeDocumentResponseSchema.parse(
    await authenticatedRequest({ method: 'POST', path: KNOWLEDGE_DOCUMENTS_PATH, body: input }),
  );
}

export async function updateKnowledgeDocument(
  documentId: string,
  input: UpdateKnowledgeDocumentInput,
): Promise<KnowledgeDocumentResponse> {
  return KnowledgeDocumentResponseSchema.parse(
    await authenticatedRequest({
      method: 'PATCH',
      path: `${KNOWLEDGE_DOCUMENTS_PATH}/${documentId}`,
      body: input,
    }),
  );
}

export async function deleteKnowledgeDocument(documentId: string): Promise<void> {
  await authenticatedRequest({
    method: 'DELETE',
    path: `${KNOWLEDGE_DOCUMENTS_PATH}/${documentId}`,
  });
}

/**
 * `POST /api/v1/knowledge-documents/{id}/reindex` — `202`, and the document goes
 * back to `pending`.
 *
 * The one recovery path for a document whose indexing failed. Re-indexing is
 * delete-and-insert in one transaction, so a document is never half-indexed:
 * retrieval sees the old chunk set or the new one, never a mixture.
 */
export async function reindexKnowledgeDocument(
  documentId: string,
): Promise<KnowledgeDocumentResponse> {
  return KnowledgeDocumentResponseSchema.parse(
    await authenticatedRequest({
      method: 'POST',
      path: `${KNOWLEDGE_DOCUMENTS_PATH}/${documentId}/reindex`,
    }),
  );
}

export async function getAiConfig(): Promise<AiConfigResponse> {
  return AiConfigResponseSchema.parse(
    await authenticatedRequest({ method: 'GET', path: AI_CONFIG_PATH }),
  );
}

/**
 * Partial by construction, like every other settings surface here: saving the
 * threshold cannot clobber a system prompt this form never showed.
 */
export async function updateAiConfig(input: UpdateAiConfigInput): Promise<AiConfigResponse> {
  return AiConfigResponseSchema.parse(
    await authenticatedRequest({ method: 'PATCH', path: AI_CONFIG_PATH, body: input }),
  );
}

/** `GET /api/v1/conversations/{id}/handoff` — the most recent handoff, or `404`. */
export async function getHandoffContext(conversationId: string): Promise<HandoffContextResponse> {
  return HandoffContextResponseSchema.parse(
    await authenticatedRequest({
      method: 'GET',
      path: `${CONVERSATIONS_PATH}/${conversationId}/handoff`,
    }),
  );
}

/**
 * `POST /api/v1/conversations/{id}/handoff` — an agent taking a bot-active
 * thread.
 *
 * No body: the reason is always `agent_requested`, and a client that could name
 * a different one would be reporting why the *bot* stopped, which it cannot
 * know. Idempotent — a thread already handed off answers `200` and writes
 * nothing, so a double-click is a no-op rather than a `409`.
 */
export async function requestHandoff(conversationId: string): Promise<ConversationResponse> {
  return ConversationResponseSchema.parse(
    await authenticatedRequest({
      method: 'POST',
      path: `${CONVERSATIONS_PATH}/${conversationId}/handoff`,
      body: {},
    }),
  );
}
