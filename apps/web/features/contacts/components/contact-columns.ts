import type { ContactResponse } from '@whatsappcrm/contracts';
import type { DataTableColumn } from '@/components/ui/DataTable';
import type { Content } from '@/lib/content';

/**
 * Column metadata for the contacts table, without the cell renderers.
 *
 * The real table and its skeleton both build from this, which is what keeps the
 * skeleton from drifting: adding a column changes one array and both stay in
 * step, at every width and in both themes.
 */

export type ContactColumnMeta = Omit<DataTableColumn<ContactResponse>, 'render'>;

export function contactColumnMeta(content: Content): ContactColumnMeta[] {
  return [
    { key: 'name', header: content.contacts.columnName },
    { key: 'phone', header: content.contacts.columnPhone, isNarrow: true },
    { key: 'email', header: content.contacts.columnEmail },
    { key: 'tags', header: content.contacts.columnTags },
    { key: 'lastContacted', header: content.contacts.columnLastContacted, isNarrow: true },
  ];
}
