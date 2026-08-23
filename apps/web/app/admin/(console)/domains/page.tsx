import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { parseAdminDomainStatus, searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { PageHeader } from '@/components/shell/PageHeader';
import { PageShell } from '@/components/shell/PageShell';
import {
  DomainQueueSection,
  DomainQueueSectionSkeleton,
} from '@/features/platform-admin/components/DomainQueueSection';

/**
 * The custom-domain activation queue. Composition only: the header, then the
 * section behind its own Suspense boundary and its own error boundary.
 *
 * Which half is shown rides in the URL — "here is what is still waiting" is a
 * link an operator sends, and `?status=` is the same word `AdminDomainQuerySchema`
 * takes, so the parameter and the query it becomes cannot drift.
 */

export const metadata: Metadata = {
  title: content.platformAdmin.domains.title,
  description: content.platformAdmin.domains.subtitle,
};

/** Reads the queue behind a credential; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function PlatformAdminDomainsPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const query = await searchParams;
  const status = parseAdminDomainStatus(firstSearchParam(query[searchParamKeys.adminDomainStatus]));

  return (
    <PageShell>
      <PageHeader
        title={content.platformAdmin.domains.title}
        subtitle={content.platformAdmin.domains.subtitle}
      />
      <SectionErrorBoundary>
        {/* Keyed on the half being shown, so switching pills remounts into the
            skeleton rather than holding the other half's rows while it reads. */}
        <Suspense key={status} fallback={<DomainQueueSectionSkeleton status={status} />}>
          <DomainQueueSection status={status} />
        </Suspense>
      </SectionErrorBoundary>
    </PageShell>
  );
}
