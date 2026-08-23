import { content } from '@/content/en';
import { ADMIN_DOMAIN_STATUS_DEFAULT } from '@/lib/routes';
import { PageHeader } from '@/components/shell/PageHeader';
import { PageShell } from '@/components/shell/PageShell';
import { DomainQueueSectionSkeleton } from '@/features/platform-admin/components/DomainQueueSection.Skeleton';

/**
 * The route-level skeleton, composed from the page's own section skeleton in the
 * same shell with the same header, so arriving here does not reflow when the real
 * page lands.
 *
 * It shows the **default** half's pills. A `loading.tsx` is rendered before the
 * segment's `searchParams` are available, so which half was asked for is not
 * knowable here — and the default is what an operator arriving at this screen
 * from the rail is about to see. Navigating *between* halves is covered by the
 * page's own keyed Suspense boundary, which does know.
 */
export default function PlatformAdminDomainsLoading() {
  return (
    <PageShell>
      <PageHeader
        title={content.platformAdmin.domains.title}
        subtitle={content.platformAdmin.domains.subtitle}
      />
      <DomainQueueSectionSkeleton status={ADMIN_DOMAIN_STATUS_DEFAULT} />
    </PageShell>
  );
}
