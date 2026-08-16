import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { requirePermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { ContactsFilterSection } from '@/features/contacts/components/ContactsFilterSection';
import { ContactsFilterBarSkeleton } from '@/features/contacts/components/ContactsFilterBar.Skeleton';
import {
  ContactsSection,
  ContactsSectionSkeleton,
} from '@/features/contacts/components/ContactsSection';
import { parseContactListParams } from '@/features/contacts/contact-params';

/**
 * The contact directory (TAR-33). Composition only: gate, header, and two
 * independently-failing regions — the filter bar and the list.
 */

export const metadata: Metadata = {
  title: `${content.contacts.title} · ${content.app.name}`,
  description: content.contacts.subtitle,
};

/** Per-principal and per-URL, so nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const session = await requirePermission('contact:read');

  if (session === null) {
    return <ForbiddenState />;
  }

  const params = await searchParams;
  const filters = parseContactListParams({
    q: firstSearchParam(params[searchParamKeys.contactsQuery]),
    tag: firstSearchParam(params[searchParamKeys.contactsTag]),
  });

  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.contacts.title} subtitle={content.contacts.subtitle} />

        {/* Its own boundary: a failed tag read must not cost the visitor the
            directory they came for. */}
        <SectionErrorBoundary>
          <Suspense fallback={<ContactsFilterBarSkeleton />}>
            <ContactsFilterSection />
          </Suspense>
        </SectionErrorBoundary>

        <SectionErrorBoundary>
          {/* Keyed on the filters so a filter change shows the skeleton again
              rather than leaving stale rows on screen while the new page streams. */}
          <Suspense
            key={`${filters.q ?? ''}:${filters.tagId ?? ''}`}
            fallback={<ContactsSectionSkeleton />}
          >
            <ContactsSection filters={filters} />
          </Suspense>
        </SectionErrorBoundary>
      </Stack>
    </PageShell>
  );
}
