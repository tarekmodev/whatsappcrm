import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import type { DataTableColumn } from '@/components/ui/DataTable';
import type { Content } from '@/lib/content';

/**
 * Column metadata for the saved-reply table, without the cell renderers.
 *
 * The real table and its skeleton both build from this, so adding a column
 * changes one array and both stay in step.
 */

export type CannedResponseColumnMeta = Omit<DataTableColumn<CannedResponseResponse>, 'render'>;

export function cannedResponseColumnMeta(
  content: Content,
  hasActions: boolean,
): CannedResponseColumnMeta[] {
  const columns: CannedResponseColumnMeta[] = [
    // Narrow: a shortcut is at most 40 characters and is what the eye scans for,
    // so it keeps its own column rather than sharing the body's free space.
    { key: 'shortcut', header: content.cannedResponses.columnShortcut, isNarrow: true },
    { key: 'title', header: content.cannedResponses.columnName },
    { key: 'body', header: content.cannedResponses.columnText },
  ];

  if (hasActions) {
    columns.push({
      key: 'actions',
      header: content.cannedResponses.columnActions,
      isHeaderHidden: true,
      isNarrow: true,
    });
  }

  return columns;
}
