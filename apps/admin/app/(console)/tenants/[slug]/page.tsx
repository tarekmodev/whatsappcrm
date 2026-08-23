import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { PageShell } from '@/components/shell/PageShell';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { content } from '~/content/en';
import { searchParamKeys } from '~/lib/routes';
import { TenantSection } from '~/features/tenants/components/TenantSection';
import { TenantSectionSkeleton } from '~/features/tenants/components/TenantSection.Skeleton';

/**
 * One tenant. Composition only: the section owns its own header, because the
 * heading depends on a read — and a page that rendered the header itself would
 * have to make the same read twice.
 */

export const metadata: Metadata = {
  title: content.tenants.title,
};

/** Reads one tenant's trail behind a credential; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function TenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<RouteSearchParams>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const cursor = firstSearchParam(query[searchParamKeys.trailCursor]);

  return (
    <PageShell>
      <SectionErrorBoundary>
        {/*
          Keyed on the pair the section reads, so moving to another page of the
          trail — or to another tenant through the domain queue's link — remounts
          into the skeleton rather than holding the previous tenant's rows on
          screen while the new read is in flight.
        */}
        <Suspense key={`${slug}:${cursor ?? ''}`} fallback={<TenantSectionSkeleton />}>
          <TenantSection slug={slug} cursor={cursor} />
        </Suspense>
      </SectionErrorBoundary>
    </PageShell>
  );
}
