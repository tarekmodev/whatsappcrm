import { DataTableSkeleton } from '@/components/ui/DataTable';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { content } from '@/content/en';
import { CONTACTS_PAGE_SIZE } from '../constants';
import { contactColumnMeta } from './contact-columns';

/**
 * The directory's placeholder. Usage: `<ContactsTableSkeleton />`.
 *
 * Cannot drift from the table, because both build their columns from
 * `contactColumnMeta` — same columns, same widths, same stacking breakpoint. Row
 * count matches `CONTACTS_PAGE_SIZE`, which is what the server actually asks for,
 * so a full page swaps in without shifting anything below it.
 *
 * Its own file rather than an export beside the table: the route's `loading.tsx`
 * imports it statically, and a shared module would drag the table's imports into
 * that chunk.
 */
export function ContactsTableSkeleton() {
  return (
    <>
      <LoadingAnnouncement label={content.contacts.listLoading} />
      <DataTableSkeleton
        caption={content.contacts.listHeading}
        rowCount={CONTACTS_PAGE_SIZE}
        columns={contactColumnMeta(content).map((meta) => ({ ...meta, render: () => null }))}
        // The real table's threshold. Without it the placeholder is a table at a
        // width where the loaded directory is still a stack of cards (TAR-727).
        unstackAt="wide"
      />
    </>
  );
}
