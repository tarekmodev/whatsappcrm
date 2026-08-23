import { Notice } from '@/components/ui/Notice';
import { content } from '@/content/en';
import type { PermissionChecker } from '@/lib/session/permissions';
import { loadChatbotConfig, type KnowledgeDocumentsData } from '../chatbot.data';
import { CHATBOT_PERMISSIONS, KNOWLEDGE_DOCUMENTS_PAGE_SIZE } from '../constants';
import { KnowledgeDocumentsTable } from './KnowledgeDocumentsTable';

/**
 * The filtered result set: the truncation notice and the table, or the empty
 * state that replaces both. Usage: inside the Suspense boundary **keyed on the
 * filters** in `KnowledgeBaseSection`, with `KnowledgeDocumentsTableSkeleton` as
 * the fallback.
 *
 * Keyed is right here and wrong for the filter bar above it: a filter change
 * should fall back to the table's skeleton rather than leave stale rows under a
 * new filter, and this subtree holds no typing to lose.
 *
 * Returns a fragment rather than a `Stack`. `Suspense` and `Fragment` render no
 * DOM node, so the notice and the table become direct children of the card's own
 * `Stack gap="4"` — bar, notice, table, one gap between each. A second stack here
 * would double the gap.
 *
 * The two reads run together: `documentsPromise` is already in flight from the
 * page, and the configuration is memoised for the render pass, so awaiting both
 * costs one round trip rather than two.
 */
export async function KnowledgeDocumentsPanel({
  documentsPromise,
  isFiltered,
  checker,
}: {
  documentsPromise: Promise<KnowledgeDocumentsData>;
  /** A search term or a status is applied, which changes the empty state and the notice. */
  isFiltered: boolean;
  checker: PermissionChecker;
}) {
  const [{ documents, hasMoreDocuments }, config] = await Promise.all([
    documentsPromise,
    loadChatbotConfig(),
  ]);

  const isInPlan = !config.readiness.blockers.includes('feature_not_in_plan');
  const canWrite = checker.can(CHATBOT_PERMISSIONS.write) && isInPlan;

  return (
    <>
      {/* Only when there is more than fits. A complete list says nothing, which
          is the one case where silence is honest. `variant="quiet"` because this
          is now a standing caption sitting directly above the control that
          answers it, and a saturated block there out-shouts the search box. */}
      {hasMoreDocuments ? (
        <Notice tone="info" variant="quiet">
          {isFiltered
            ? content.chatbot.knowledgeShowingFirstFiltered(KNOWLEDGE_DOCUMENTS_PAGE_SIZE)
            : content.chatbot.knowledgeShowingFirst(KNOWLEDGE_DOCUMENTS_PAGE_SIZE)}
        </Notice>
      ) : null}

      <KnowledgeDocumentsTable
        documents={documents}
        // From the same read as the readiness panel above, so "the only entry
        // the chatbot can answer from" and "it answers from N entries" are one
        // number rather than two that can disagree.
        indexedEntryCount={config.readiness.indexedDocumentCount}
        canWrite={canWrite}
        isFiltered={isFiltered}
      />
    </>
  );
}
