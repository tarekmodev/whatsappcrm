'use client';

import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';

/**
 * Mirrors `ContactTagsCard` — the same `SectionCard` frame, the same description,
 * the same stack, and a checkbox row per placeholder tag — so the swap to the
 * real control changes no height.
 *
 * Its own file rather than an export beside the card: the lazy boundary imports
 * this statically as its fallback, so a shared module would drag the card's
 * chunk back into the route bundle and the split would do nothing.
 *
 * `canWrite` is threaded through rather than defaulted per file, because the
 * read-only variant has no submit row and reserving one would leave a gap.
 *
 * Changed in the same commit as the card it stands in for.
 */

/** Placeholder rows. The seeded vocabulary has two; a real one has a handful. */
const TAG_SKELETON_COUNT = 3;

export function ContactTagsCardSkeleton({ canWrite = true }: { canWrite?: boolean }) {
  const content = useContent();

  return (
    <SectionCard
      id="tags"
      title={content.contacts.tagsHeading}
      description={canWrite ? content.contacts.tagsDescription : content.contacts.readOnlyHint}
    >
      <Stack gap="4">
        <LoadingAnnouncement label={content.contacts.tagsLoading} />

        {canWrite ? (
          <Stack gap="3">
            {/* The real control's `legend`, which this skeleton already knows. */}
            <SkeletonForText>{content.contacts.tagsFieldLabel}</SkeletonForText>
            {Array.from({ length: TAG_SKELETON_COUNT }, (_unused, index) => (
              <SkeletonLine key={index} width="60%" height="var(--size-touch-target)" />
            ))}
          </Stack>
        ) : (
          <Cluster gap="2">
            {Array.from({ length: TAG_SKELETON_COUNT }, (_unused, index) => (
              <SkeletonLine key={index} width="5rem" />
            ))}
          </Cluster>
        )}

        {canWrite ? (
          <Cluster justify="end">
            {/* Sized like the real Save button, so the card's last row keeps its
                height when the control arrives. */}
            <SkeletonLine width="8rem" height="var(--size-control-md)" />
          </Cluster>
        ) : null}
      </Stack>
    </SectionCard>
  );
}
