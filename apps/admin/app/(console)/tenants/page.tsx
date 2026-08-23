import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SectionCard } from '@/components/ui/SectionCard';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { PageShell } from '@/components/shell/PageShell';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { content } from '~/content/en';
import { parseDomainStatus, searchParamKeys } from '~/lib/routes';
import { TenantsHeaderActions } from '~/features/tenants/components/TenantsHeaderActions';
import { TenantLookup } from '~/features/tenants/components/TenantLookup';
import { DomainQueueSection } from '~/features/domains/components/DomainQueueSection';
import { DomainQueueSectionSkeleton } from '~/features/domains/components/DomainQueueSection.Skeleton';

/**
 * The console's entry point, in the two regions the spec draws (§2.3).
 *
 * **Region 1 reads nothing** — there is no `GET /v1/admin/tenants` to read from —
 * so it is a lookup and the card says why. **Region 2 is the domain queue**, the
 * one real cross-tenant list this API serves, and the only place in the console
 * where a tenant can be found rather than typed.
 *
 * When `GET /v1/admin/tenants` lands it replaces region 1 and nothing else.
 */

export const metadata: Metadata = {
  title: content.tenants.title,
};

/** Reads the queue behind a credential; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function TenantsPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const query = await searchParams;
  const status = parseDomainStatus(firstSearchParam(query[searchParamKeys.domainStatus]));

  return (
    <PageShell>
      {/* No header action: the two actions are region 1's, beside the field they
          belong with. */}
      <PageHeader title={content.tenants.title} />

      <SectionCard
        id="lookup"
        title={content.tenants.lookupHeading}
        description={content.tenants.lookupDescription}
      >
        <Stack gap="4">
          <TenantLookup />
          <TenantsHeaderActions />
        </Stack>
      </SectionCard>

      <SectionErrorBoundary>
        {/* Keyed on the half shown, so switching remounts into the skeleton
            rather than holding the other half's rows while it reads. */}
        <Suspense key={status} fallback={<DomainQueueSectionSkeleton status={status} />}>
          <DomainQueueSection status={status} />
        </Suspense>
      </SectionErrorBoundary>
    </PageShell>
  );
}
