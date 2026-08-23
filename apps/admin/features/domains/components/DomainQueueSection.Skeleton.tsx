import type { AdminDomainStatus } from '@whatsappcrm/contracts';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { SkeletonForText } from '@/components/ui/Skeleton';
import { content } from '~/content/en';
import { DomainQueueFilter } from './DomainQueueFilter';
import { DomainQueueTableSkeleton } from './DomainQueueTable';

/**
 * What the queue looks like while its read is in flight.
 *
 * The same card, heading, gap and notice as the real section, so the swap moves
 * nothing. The **filter is the real control**: its values are known before the
 * read returns, and a shimmer standing in for a control that could simply be
 * rendered is a placeholder for its own sake — it also removes the one row this
 * card could otherwise shift by.
 *
 * The description is a placeholder, because the count genuinely is not known yet.
 */
export function DomainQueueSectionSkeleton({ status }: { status: AdminDomainStatus }) {
  return (
    <SectionCard
      id="domain-queue"
      title={content.domains.queueHeading}
      description={<SkeletonForText>{content.domains.count(6)}</SkeletonForText>}
    >
      <Stack gap="4">
        <LoadingAnnouncement label={content.domains.loading} />
        <DomainQueueFilter status={status} />
        <Notice tone="info" variant="quiet">
          {content.domains.recordOnlyNotice}
        </Notice>
        <DomainQueueTableSkeleton status={status} />
      </Stack>
    </SectionCard>
  );
}
