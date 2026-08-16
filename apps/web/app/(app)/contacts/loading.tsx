import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { ContactsFilterBarSkeleton } from '@/features/contacts/components/ContactsFilterBar.Skeleton';
import { ContactsSectionSkeleton } from '@/features/contacts/components/ContactsSection';

/**
 * The route-level skeleton, composed from the page's own section skeletons in the
 * same shell, with the same header and the same gaps — so arriving at Contacts
 * does not reflow when the real page lands.
 */
export default function ContactsLoading() {
  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.contacts.title} subtitle={content.contacts.subtitle} />
        <ContactsFilterBarSkeleton />
        <ContactsSectionSkeleton />
      </Stack>
    </PageShell>
  );
}
