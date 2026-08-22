import 'server-only';

import type { AiConfigResponse, KnowledgeDocumentListItem } from '@whatsappcrm/contracts';
import { getAiConfig, listKnowledgeDocuments } from '@/lib/api/ai';
import { KNOWLEDGE_DOCUMENTS_PAGE_SIZE } from './constants';

/**
 * Server-side reads for the chatbot settings surface: the configuration, and the
 * first page of the knowledge base.
 *
 * One read function rather than two because the two answers are read together:
 * the readiness breakdown on the config explains the state the document list is
 * in, and a page that showed one before the other would report "no automated
 * replies" above a table that had not loaded yet.
 */

export interface ChatbotData {
  readonly config: AiConfigResponse;
  readonly documents: readonly KnowledgeDocumentListItem[];
  /** True when the tenant has more entries than this page holds. */
  readonly hasMoreDocuments: boolean;
}

export async function loadChatbot(): Promise<ChatbotData> {
  // Independent requests: awaiting them in sequence would double the page's
  // TTFB for no reason.
  const [config, documents] = await Promise.all([
    getAiConfig(),
    listKnowledgeDocuments({ limit: KNOWLEDGE_DOCUMENTS_PAGE_SIZE }),
  ]);

  return {
    config,
    documents: documents.items,
    hasMoreDocuments: documents.nextCursor !== null,
  };
}
