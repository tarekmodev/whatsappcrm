import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { PageHeader } from '@/components/shell/PageHeader';
import { PageShell } from '@/components/shell/PageShell';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { content } from '~/content/en';
import { parseDomainStatus, searchParamKeys } from '~/lib/routes';
import { DomainQueueSection } from '~/features/domains/components/DomainQueueSection';
import { DomainQueueSectionSkeleton } from '~/features/domains/components/DomainQueueSection.Skeleton';

/**
 * The domain queue on a route of its own: the same table as the Tenants screen's
 * region 2, without region 1 above it and with its own header (spec §2.8). Built
 * once and rendered in both.
 */

export const metadata: Metadata = {
  title: content.domains.title,
};

export const dynamic = 'force-dynamic';

export default async function DomainsPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const query = await searchParams;
  const status = parseDomainStatus(firstSearchParam(query[searchParamKeys.domainStatus]));

  return (
    <PageShell>
      <PageHeader title={content.domains.title} />
      <SectionErrorBoundary>
        <Suspense key={status} fallback={<DomainQueueSectionSkeleton status={status} />}>
          <DomainQueueSection status={status} />
        </Suspense>
      </SectionErrorBoundary>
    </PageShell>
  );
}
