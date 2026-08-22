import type { KnowledgeDocumentListItem, KnowledgeDocumentResponse } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * `knowledge_documents` → the two shapes the console reads.
 *
 * **Two projections, deliberately.** `content` is capped at 256 KiB per
 * document, so a 25-row page loading it would be a six-megabyte response for a
 * list that renders a title, a status and a chunk count. The list therefore
 * selects everything *except* `content`, and the single read is the only place
 * it is fetched — the "one query shape per use case" rule, on the one table in
 * this story where ignoring it is measurably expensive.
 *
 * The two are kept in step by construction: `LIST_PROJECTION` is the source, and
 * `DOCUMENT_PROJECTION` is it plus `content`.
 */

export const LIST_PROJECTION = {
  id: true,
  title: true,
  sourceUrl: true,
  language: true,
  status: true,
  chunkCount: true,
  indexError: true,
  indexedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.KnowledgeDocumentSelect;

export const DOCUMENT_PROJECTION = {
  ...LIST_PROJECTION,
  content: true,
} as const satisfies Prisma.KnowledgeDocumentSelect;

export type KnowledgeDocumentListRow = Prisma.KnowledgeDocumentGetPayload<{
  select: typeof LIST_PROJECTION;
}>;

export type KnowledgeDocumentRow = Prisma.KnowledgeDocumentGetPayload<{
  select: typeof DOCUMENT_PROJECTION;
}>;

export function toKnowledgeDocumentListItem(
  document: KnowledgeDocumentListRow,
): KnowledgeDocumentListItem {
  return {
    id: document.id,
    title: document.title,
    sourceUrl: document.sourceUrl,
    language: document.language,
    status: document.status,
    chunkCount: document.chunkCount,
    indexError: document.indexError,
    indexedAt: document.indexedAt?.toISOString() ?? null,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

export function toKnowledgeDocumentResponse(
  document: KnowledgeDocumentRow,
): KnowledgeDocumentResponse {
  return { ...toKnowledgeDocumentListItem(document), content: document.content };
}
