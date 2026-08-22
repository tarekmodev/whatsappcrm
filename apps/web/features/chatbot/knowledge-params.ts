import {
  KNOWLEDGE_DOCUMENT_STATUSES,
  KnowledgeDocumentListQuerySchema,
  type KnowledgeDocumentStatus,
} from '@whatsappcrm/contracts';

/**
 * The knowledge base table's URL state, narrowed from untrusted query
 * parameters (TAR-613).
 *
 * Validated against the *contract's* own schema rather than cast, so a
 * hand-edited `?status=archived` or a search term past the contract's ceiling
 * falls back to the unfiltered view instead of reaching the API as a query it
 * answers 400. Extracted from the page so the page stays composition-only and
 * this is testable without rendering a route — `contact-params.ts` is the
 * precedent, tests and all.
 */

export interface KnowledgeListParams {
  /**
   * A title fragment. `q` is a plain case-insensitive match over `title` — a
   * console filter, not the retrieval path the chatbot itself uses.
   */
  q: string | undefined;
  /** `undefined` is every entry, whatever its indexing state. */
  status: KnowledgeDocumentStatus | undefined;
}

export function parseKnowledgeListParams(raw: {
  q: string | undefined;
  status: string | undefined;
}): KnowledgeListParams {
  return { q: parseQuery(raw.q), status: parseStatus(raw.status) };
}

function parseQuery(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  // Trimmed first, because a term the reader typed as ` returns ` and one they
  // typed as `returns` are the same search, and two URLs for one view is two
  // cache entries and two history entries.
  const parsed = KnowledgeDocumentListQuerySchema.shape.q.safeParse(value.trim());

  return parsed.success ? parsed.data : undefined;
}

function parseStatus(value: string | undefined): KnowledgeDocumentStatus | undefined {
  // Anything unrecognised degrades to the unfiltered view rather than an error
  // card: a stale link from before a status was renamed should still show the
  // knowledge base.
  return KNOWLEDGE_DOCUMENT_STATUSES.find((status) => status === value);
}
