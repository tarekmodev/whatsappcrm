import type { AdminDomainStatus } from '@whatsappcrm/contracts';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterPills } from '@/components/ui/FilterPills';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { listPendingDomains } from '@/lib/api/admin';
import { domainQueuePills } from '../domain-queue';
import { DomainQueueTable } from './DomainQueueTable';
import { DomainQueueSectionSkeleton } from './DomainQueueSection.Skeleton';

/**
 * The custom-domain activation queue. Usage:
 * `<DomainQueueSection status={status} />`.
 *
 * A server component: the read happens once on the server, so the page stays
 * composition only and no client bundle ships it. The card frame and the pills
 * are owned here rather than in the page, which is what lets the skeleton beside
 * this file reuse the identical frame.
 *
 * The two halves are pills rather than `Tabs`, and that is forced rather than
 * chosen: both live on `/admin/domains` and differ by a query parameter, and
 * `Tabs` decides which one is current by comparing pathnames — so it would mark
 * both. `FilterPills` takes `isCurrent` from the caller for exactly this case.
 */
export async function DomainQueueSection({ status }: { status: AdminDomainStatus }) {
  const copy = content.platformAdmin.domains;
  const domains = await listPendingDomains(status);
  const isWaiting = status === 'verified';

  return (
    <SectionCard id="domain-queue" title={copy.queueHeading} description={copy.queueDescription}>
      <Stack gap="4">
        <FilterPills label={copy.filterLabel} items={domainQueuePills(status)} />
        <Notice tone="info" variant="quiet">
          {copy.recordOnlyNotice}
        </Notice>
        {domains.length === 0 ? (
          <EmptyState
            icon="globe"
            title={isWaiting ? copy.emptyWaitingTitle : copy.emptyLiveTitle}
            description={isWaiting ? copy.emptyWaitingBody : copy.emptyLiveBody}
          />
        ) : (
          <DomainQueueTable domains={domains} status={status} />
        )}
      </Stack>
    </SectionCard>
  );
}

export { DomainQueueSectionSkeleton };
