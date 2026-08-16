import type { CustomFieldDefinition } from '@whatsappcrm/contracts';
import type { DataTableColumn } from '@/components/ui/DataTable';
import type { Content } from '@/lib/content';

/**
 * Column metadata for the definition table, without the cell renderers.
 *
 * The real table and its skeleton both build from this, so adding a column
 * changes one array and both stay in step.
 */

export type CustomFieldColumnMeta = Omit<DataTableColumn<CustomFieldDefinition>, 'render'>;

export function customFieldColumnMeta(
  content: Content,
  hasActions: boolean,
): CustomFieldColumnMeta[] {
  const columns: CustomFieldColumnMeta[] = [
    { key: 'label', header: content.customFields.columnLabel },
    { key: 'key', header: content.customFields.columnKey },
    { key: 'type', header: content.customFields.columnType, isNarrow: true },
    { key: 'options', header: content.customFields.columnOptions },
  ];

  if (hasActions) {
    columns.push({
      key: 'actions',
      header: content.customFields.columnActions,
      isHeaderHidden: true,
      isNarrow: true,
    });
  }

  return columns;
}
