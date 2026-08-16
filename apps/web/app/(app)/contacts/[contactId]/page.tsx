import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { requirePermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { TextLink } from '@/components/ui/TextLink';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  ContactProfileSection,
  ContactProfileSectionSkeleton,
} from '@/features/contacts/components/ContactProfileSection';
import { ContactUnavailable } from '@/features/contacts/components/ContactUnavailable';
import { parseContactId } from '@/features/contacts/contact-params';

/**
 * One contact: their identity, their tags, and the tenant's custom fields as
 * editable values. Composition only.
 */

export const metadata: Metadata = {
  title: `${content.contacts.profileHeading} · ${content.app.name}`,
  description: content.contacts.subtitle,
};

/** Per-principal, and edited in place. Nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function ContactPage({ params }: { params: Promise<{ contactId: string }> }) {
  const session = await requirePermission('contact:read');

  if (session === null) {
    return <ForbiddenState />;
  }

  const { contactId: rawContactId } = await params;
  // A segment that is not a UUID names no contact. Answered with the same state
  // a contact outside this reader's tenant gets, rather than an error card: from
  // the reader's side a truncated link and an invisible contact are the same
  // event.
  const contactId = parseContactId(rawContactId);

  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader
          title={content.contacts.profileHeading}
          action={<TextLink href={routes.contacts()}>{content.contacts.backToContacts}</TextLink>}
        />

        {contactId === null ? (
          <ContactUnavailable />
        ) : (
          <SectionErrorBoundary>
            <Suspense key={contactId} fallback={<ContactProfileSectionSkeleton />}>
              <ContactProfileSection contactId={contactId} checker={session.checker} />
            </Suspense>
          </SectionErrorBoundary>
        )}
      </Stack>
    </PageShell>
  );
}
