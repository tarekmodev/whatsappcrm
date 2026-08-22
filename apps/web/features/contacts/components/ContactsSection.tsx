import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { content } from '@/content/en';
import { loadContacts } from '../contacts.data';
import { contactsDirectorySummary } from '../directory-summary';
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
 *
 * **The card's title is hidden** (TAR-727). "Contacts" under an `<h1>` reading
 * "Contacts" is the same word twice, and this route has one card — so the name
 * stays for the document outline and the region label, and the visible top of
 * the card is the count. The ticket queue answered the same duplication the same
 * way in TAR-520.
 */
export async function ContactsSection({ filters }: { filters: ContactListParams }) {
  const { contacts, hasMore } = await loadContacts(filters);
  const isFiltered = filters.q !== undefined || filters.tagId !== undefined;

  return (
    <SectionCard
      id="contacts"
      title={content.contacts.listHeading}
      isTitleVisible={false}
      // `?? undefined`, because `SectionCard` renders no description line at all
      // for `undefined` — and an untruncated empty directory has nothing to say
      // that the table's own empty state does not already say better.
      description={contactsDirectorySummary(contacts.length, hasMore, content) ?? undefined}
    >
      <ContactsTable contacts={contacts} isFiltered={isFiltered} />
    </SectionCard>
  );
}

/**
 * The same frame with the table's own skeleton inside it, so nothing reflows.
 *
 * The count is a placeholder rather than nothing: it is one line of the card's
 * header, and leaving it out while the read is in flight moved everything below
 * it when the sentence arrived.
 */
export function ContactsSectionSkeleton() {
  return (
    <SectionCard
      id="contacts"
      title={content.contacts.listHeading}
      isTitleVisible={false}
      // Sized to the copy it stands in for — "25 contacts" — and to a whole line
      // box of it, because the line is a block child of the description
      // paragraph and would otherwise be shorter than the sentence it replaces.
      description={
        <SkeletonLine
          width="6rem"
          height="calc(var(--font-size-body-sm) * var(--line-height-body))"
        />
      }
    >
      <ContactsTableSkeleton />
    </SectionCard>
  );
}
