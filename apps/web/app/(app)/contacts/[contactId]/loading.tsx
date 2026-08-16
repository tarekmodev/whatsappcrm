import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { TextLink } from '@/components/ui/TextLink';
import { ContactProfileSectionSkeleton } from '@/features/contacts/components/ContactProfileSection';

/**
 * Route-level skeleton, composed from the page's own section skeleton and the
 * same frame — including the back link, which is a constant and has nothing to
 * wait for.
 */
export default function ContactLoading() {
  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader
          title={content.contacts.profileHeading}
          action={<TextLink href={routes.contacts()}>{content.contacts.backToContacts}</TextLink>}
        />
        <ContactProfileSectionSkeleton />
      </Stack>
    </PageShell>
  );
}
