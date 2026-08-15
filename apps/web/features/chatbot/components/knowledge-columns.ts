import type { KnowledgeDocumentResponse } from '@whatsappcrm/contracts';
import type { DataTableColumn } from '@/components/ui/DataTable';
import type { Content } from '@/lib/content';

/**
 * Column metadata for the knowledge base table, without the cell renderers.
 *
 * The real table and its skeleton both build from this, which is what keeps the
 * skeleton from drifting: adding a column changes one array and both stay in
 * step.
 */

export type KnowledgeColumnMeta = Omit<DataTableColumn<KnowledgeDocumentResponse>, 'render'>;

export function knowledgeColumnMeta(content: Content, hasActions: boolean): KnowledgeColumnMeta[] {
  const columns: KnowledgeColumnMeta[] = [
    { key: 'title', header: content.chatbot.columnTitle },
    { key: 'status', header: content.chatbot.columnStatus, isNarrow: true },
    { key: 'chunks', header: content.chatbot.columnChunks, isNarrow: true },
    { key: 'updated', header: content.chatbot.columnUpdated, isNarrow: true },
  ];

  if (hasActions) {
    columns.push({
      key: 'actions',
      header: content.chatbot.columnActions,
      isHeaderHidden: true,
      isNarrow: true,
    });
  }

  return columns;
}
