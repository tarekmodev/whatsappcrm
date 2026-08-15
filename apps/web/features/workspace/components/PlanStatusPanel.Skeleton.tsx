import { AutoGrid } from '@/components/layout/AutoGrid';
import { Stack } from '@/components/layout/Stack';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { UsageMeter } from '@/components/ui/UsageMeter';
import { DetailList } from '@/components/ui/DetailList';
import { useContent } from '@/lib/content';

/**
 * Mirrors `PlanStatusPanel` — same stack and gap, the same `DetailList`, the same
 * `AutoGrid` of two meters — so the swap to real content changes no height.
 *
 * The terms are the real strings, because they are copy this skeleton already
 * knows; only the values are placeholders, because they are data that has not
 * arrived. Two detail rows rather than five: `status` and `plan` are always
 * present and the three dates are conditional, so guessing high would leave the
 * card taller than the content that replaces it.
 *
 * Both meters render through the real `UsageMeter` with a shimmer in place of
 * the summary, rather than a hand-drawn approximation — that is what stops the
 * two drifting apart. `ratio` is `0` rather than omitted: an empty track is the
 * same height as a full one, and omitting it would drop the bar and shorten the
 * card by a row.
 *
 * Changed in the same commit as the panel it stands in for.
 */
export function PlanStatusPanelSkeleton() {
  const content = useContent();

  return (
    <Stack gap="5">
      <LoadingAnnouncement label={content.workspace.loading} />
      <DetailList
        items={[
          {
            id: 'status',
            term: content.workspace.statusLabel,
            value: <SkeletonLine width="6rem" />,
          },
          { id: 'plan', term: content.workspace.planLabel, value: <SkeletonLine width="8rem" /> },
        ]}
      />
      <AutoGrid minItemWidth="16rem" gap="5">
        <UsageMeter
          heading={content.workspace.seatsHeading}
          summary={<SkeletonForText>{content.workspace.seatsUsage('0', '0')}</SkeletonForText>}
          ratio={0}
        />
        <UsageMeter
          heading={content.workspace.conversationsHeading}
          summary={
            <SkeletonForText>{content.workspace.conversationsUsage('0', '0')}</SkeletonForText>
          }
          ratio={0}
        />
      </AutoGrid>
    </Stack>
  );
}
