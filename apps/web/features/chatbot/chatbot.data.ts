import 'server-only';

import { cache } from 'react';
import type { AiConfigResponse, KnowledgeDocumentListItem } from '@whatsappcrm/contracts';
import { getAiConfig, listKnowledgeDocuments } from '@/lib/api/ai';
import { KNOWLEDGE_DOCUMENTS_PAGE_SIZE } from './constants';
import type { KnowledgeListParams } from './knowledge-params';

/**
 * Server-side reads for the chatbot settings surface: the configuration, and one
 * filtered page of the knowledge base.
 *
 * Two reads rather than one (TAR-613). They used to be a single `Promise.all`
 * because the two answers are read together — but the knowledge base is now
 * filtered from the URL, and its Suspense boundary is keyed on those filters so
 * a filter change shows the table's skeleton rather than stale rows. The
 * configuration must *not* be behind that key: it is what an admin's unsaved
 * system prompt is rendered from, and remounting it on every debounce tick would
 * throw the edit away.
 *
 * The parallelism survives the split. `page.tsx` starts the documents read
 * before anything renders and hands the promise to both consumers, and the
 * config read is memoised for the render pass — so the two requests are still in
 * flight together, and one pass still makes one request for each.
 */

/**
 * The chatbot's configuration, once per render pass.
 *
 * `cache()` because three components now need it — the settings form, the card's
 * `Add entry` gate, and the table's delete warning — and each of them sits in a
 * different boundary. Without it the page would ask the API three times for one
 * answer; with it, "the bot answers from N entries" is one number that cannot
 * disagree with itself.
 */
export const loadChatbotConfig = cache(
  async function loadChatbotConfig(): Promise<AiConfigResponse> {
    return getAiConfig();
  },
);

export interface KnowledgeDocumentsData {
  readonly documents: readonly KnowledgeDocumentListItem[];
  /**
   * True when the tenant has more matching entries than this page holds.
   *
   * `nextCursor !== null` says "more than ten matched", never how many: the
   * endpoint returns no total. That is why the notice it drives asks the reader
   * to narrow the search rather than quoting a count it would have to invent.
   */
  readonly hasMoreDocuments: boolean;
}

export async function loadKnowledgeDocuments(
  filters: KnowledgeListParams,
): Promise<KnowledgeDocumentsData> {
  const page = await listKnowledgeDocuments({
    limit: KNOWLEDGE_DOCUMENTS_PAGE_SIZE,
    q: filters.q,
    status: filters.status,
  });

  return { documents: page.items, hasMoreDocuments: page.nextCursor !== null };
}
