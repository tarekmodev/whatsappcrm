import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import { loadContacts } from '../contacts.data';
import type { ContactListParams } from '../contact-params';
import { ContactsTable } from './ContactsTable';
import { ContactsTableSkeleton } from './ContactsTable.Skeleton';

/**
 * Fetches the directory and frames it. Usage: inside a Suspense boundary on the
 * contacts page, keyed on the filters, with `ContactsSectionSkeleton` as the
 * fallback.
 *
 * A server component, so the read and the tenant scoping both happen on the
 * server and the client bundle carries neither.
 */
export async function ContactsSection({ filters }: { filters: ContactListParams }) {
  const contacts = await loadContacts(filters);
  const isFiltered = filters.q !== undefined || filters.tagId !== undefined;

  return (
    <SectionCard
      id="contacts"
      title={content.contacts.listHeading}
      description={content.contacts.listCountDescription(contacts.length)}
    >
      <ContactsTable contacts={contacts} isFiltered={isFiltered} />
    </SectionCard>
  );
}

/** The same frame with the table's own skeleton inside it, so nothing reflows. */
export function ContactsSectionSkeleton() {
  return (
    <SectionCard id="contacts" title={content.contacts.listHeading}>
      <ContactsTableSkeleton />
    </SectionCard>
  );
}
