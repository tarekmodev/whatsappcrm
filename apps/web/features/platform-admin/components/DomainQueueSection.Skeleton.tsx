import type { AdminDomainStatus } from '@whatsappcrm/contracts';
import { FilterPills } from '@/components/ui/FilterPills';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { domainQueuePills } from '../domain-queue';
import { DomainQueueTableSkeleton } from './DomainQueueTable';

/**
 * What the domain queue looks like while its read is in flight.
 *
 * The same `SectionCard`, the same heading and description, the same stack gap
 * and the same notice as `DomainQueueSection` — so the swap to real rows moves
 * nothing.
 *
 * The filter pills are the **real** control rather than a placeholder. Their
 * targets are known before the read returns — they are links built from the
 * query's enum and the current value, both of which this component already has —
 * and a shimmer standing in for a control that could simply be rendered is a
 * placeholder for its own sake. It also removes the one row this card could
 * otherwise shift by when the table lands.
 *
 * The table's placeholder is the real table's own skeleton, built from the same
 * column set, so it cannot drift when a column is added.
 */
export function DomainQueueSectionSkeleton({ status }: { status: AdminDomainStatus }) {
  const copy = content.platformAdmin.domains;

  return (
    <SectionCard id="domain-queue" title={copy.queueHeading} description={copy.queueDescription}>
      <Stack gap="4">
        <LoadingAnnouncement label={copy.loading} />
        <FilterPills label={copy.filterLabel} items={domainQueuePills(status)} />
        <Notice tone="info" variant="quiet">
          {copy.recordOnlyNotice}
        </Notice>
        <DomainQueueTableSkeleton status={status} />
      </Stack>
    </SectionCard>
  );
}
