import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { PageHeader } from '@/components/shell/PageHeader';
import { PageShell } from '@/components/shell/PageShell';
import {
  TenantLifecycleSection,
  TenantLifecycleSectionSkeleton,
} from '@/features/platform-admin/components/TenantLifecycleSection';

/**
 * One tenant, as the platform sees it. Composition only: the header, then the
 * section behind its own Suspense boundary and its own error boundary.
 *
 * The `<h1>` is the slug. Nothing on the admin read surface returns a tenant's
 * display name, and a heading built from a name this console was never given
 * would be the only invented thing on the screen.
 *
 * Streamed rather than awaited, so the shell and the heading paint while the
 * trail is in flight — and the fallback is the section's own skeleton, which
 * renders the same three cards at the same heights.
 */

export const metadata: Metadata = {
  title: content.platformAdmin.tenants.title,
  description: content.platformAdmin.tenant.subtitle,
};

/** Reads one tenant's trail behind a credential; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function PlatformAdminTenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<RouteSearchParams>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const cursor = firstSearchParam(query[searchParamKeys.adminTrailCursor]);

  return (
    <PageShell>
      <PageHeader title={slug} subtitle={content.platformAdmin.tenant.subtitle} />
      <SectionErrorBoundary>
        {/*
          Keyed on the pair the section reads, so moving to another page of the
          trail — or to another tenant through the domain queue's link — remounts
          into the skeleton rather than holding the previous tenant's rows on
          screen while the new read is in flight.
        */}
        <Suspense key={`${slug}:${cursor ?? ''}`} fallback={<TenantLifecycleSectionSkeleton />}>
          <TenantLifecycleSection slug={slug} cursor={cursor} />
        </Suspense>
      </SectionErrorBoundary>
    </PageShell>
  );
}
