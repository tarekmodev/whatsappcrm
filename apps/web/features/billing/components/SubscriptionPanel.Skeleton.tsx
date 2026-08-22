import { AutoGrid } from '@/components/layout/AutoGrid';
import { Stack } from '@/components/layout/Stack';
import { DetailList } from '@/components/ui/DetailList';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { UsageMeter } from '@/components/ui/UsageMeter';
import { useContent } from '@/lib/content';

/**
 * Mirrors `SubscriptionPanel` — same stack and gap, the same `DetailList`, the
 * same `AutoGrid` of two meters — so the swap to real content changes no height.
 *
 * The terms are the real strings, because they are copy this skeleton already
 * knows; only the values are placeholders, because they are data that has not
 * arrived. Three detail rows rather than six: plan, status and seats are on
 * every subscription, while the price and the two dates are conditional, and
 * guessing high would leave the card taller than the content that replaces it.
 *
 * Both meters render through the real `UsageMeter` with a shimmer in place of
 * the summary, rather than a hand-drawn approximation — that is what stops the
 * two drifting apart. `ratio` is `0` rather than omitted: an empty track is the
 * same height as a full one, and omitting it would drop the bar and shorten the
 * card by a row.
 *
 * Changed in the same commit as the panel it stands in for.
 */
export function SubscriptionPanelSkeleton() {
  const content = useContent();

  return (
    <Stack gap="5">
      <LoadingAnnouncement label={content.billing.loading} />
      <DetailList
        items={[
          { id: 'plan', term: content.billing.planLabel, value: <SkeletonLine width="8rem" /> },
          { id: 'status', term: content.billing.statusLabel, value: <SkeletonLine width="6rem" /> },
          { id: 'seats', term: content.billing.seatsLabel, value: <SkeletonLine width="3rem" /> },
        ]}
      />
      <AutoGrid minItemWidth="16rem" gap="5">
        <UsageMeter
          heading={content.billing.seatsHeading}
          summary={<SkeletonForText>{content.billing.seatsUsage('0', '0')}</SkeletonForText>}
          ratio={0}
        />
        <UsageMeter
          heading={content.billing.conversationsHeading}
          summary={
            <SkeletonForText>{content.billing.conversationsUsage('0', '0')}</SkeletonForText>
          }
          ratio={0}
        />
      </AutoGrid>
    </Stack>
  );
}
