import 'server-only';

import { cache } from 'react';
import type { AiConfigResponse, KnowledgeDocumentListItem } from '@whatsappcrm/contracts';
import { getAiConfig, listKnowledgeDocuments } from '@/lib/api/ai';
import { KNOWLEDGE_DOCUMENTS_PAGE_SIZE, SOURCE_HEALTH_SCAN_LIMIT } from './constants';
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

/**
 * How many sources are ready, indexing and failed — the three counts the health
 * strip and the pipeline rail are drawn from (TAR-813).
 *
 * **One count is exact and two are floors, and the difference is published.**
 * `indexedDocumentCount` is a real total the readiness payload already carries.
 * Nothing publishes a total for the other two: `GET /knowledge-documents` is
 * keyset-paginated and answers with items and a cursor, so the honest way to
 * count them without a new endpoint is to read one page of each and say `100+`
 * when the cursor says there is another. A knowledge base is tens of documents,
 * so that edge is rare — but a strip that rendered `100` for a tenant with 340
 * failed sources would be a number the console made up.
 *
 * Two extra requests on a page that is already `force-dynamic`, issued together
 * with the configuration read rather than after it. `cache()` for the same
 * reason `loadChatbotConfig` has it: the rail and the strip sit in different
 * boundaries and must not disagree about how many sources failed.
 */
export const loadSourceHealth = cache(async function loadSourceHealth(): Promise<SourceHealth> {
  const [config, indexing, failed] = await Promise.all([
    loadChatbotConfig(),
    listKnowledgeDocuments({ limit: SOURCE_HEALTH_SCAN_LIMIT, status: 'pending' }),
    listKnowledgeDocuments({ limit: SOURCE_HEALTH_SCAN_LIMIT, status: 'failed' }),
  ]);

  return {
    readyCount: config.readiness.indexedDocumentCount,
    indexingCount: indexing.items.length,
    failedCount: failed.items.length,
    isIndexingCapped: indexing.nextCursor !== null,
    isFailedCapped: failed.nextCursor !== null,
  };
});

export interface SourceHealth {
  /** Exact: the API publishes it as `readiness.indexedDocumentCount`. */
  readonly readyCount: number;
  readonly indexingCount: number;
  readonly failedCount: number;
  /** True when the count is a floor — another page matched, so it renders as `N+`. */
  readonly isIndexingCapped: boolean;
  readonly isFailedCapped: boolean;
}

/** Whether the tenant has any source at all, which is what decides if the strip is drawn. */
export function hasAnySources(health: SourceHealth): boolean {
  return health.readyCount + health.indexingCount + health.failedCount > 0;
}
