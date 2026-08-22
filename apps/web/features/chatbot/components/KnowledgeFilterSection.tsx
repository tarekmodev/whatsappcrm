import type { KnowledgeDocumentsData } from '../chatbot.data';
import { KnowledgeFilterBar } from './KnowledgeFilterBar';

/**
 * Decides whether the knowledge base has anything to filter, and renders the bar
 * if it does. Usage: inside its own **unkeyed** Suspense boundary in
 * `KnowledgeBaseSection`, with `KnowledgeFilterBarSkeleton` as the fallback.
 *
 * A boundary of its own rather than part of the table's, and this is the whole
 * point of the split (TAR-613): the table's boundary is keyed on the filters, and
 * a `key` change remounts its subtree unconditionally. A search box inside it
 * would be destroyed and rebuilt on every debounce tick — losing the caret, and
 * dropping the keystrokes typed after the pause. `ContactsFilterSection` is the
 * same shape for the same reason.
 *
 * It takes the promise the page already started rather than reading again, so
 * the bar and the table are answered by one request.
 */
export async function KnowledgeFilterSection({
  documentsPromise,
  isFiltered,
}: {
  documentsPromise: Promise<KnowledgeDocumentsData>;
  isFiltered: boolean;
}) {
  const { documents } = await documentsPromise;

  // A tenant who has never added an entry gets the empty state alone — a filter
  // row over nothing is furniture. A filtered view always keeps the bar, because
  // it is the only way back.
  return isFiltered || documents.length > 0 ? <KnowledgeFilterBar /> : null;
}
