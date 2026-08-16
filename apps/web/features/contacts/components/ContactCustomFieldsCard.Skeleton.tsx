'use client';

import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { CONTACT_CUSTOM_FIELD_SKELETON_COUNT } from '../constants';

/**
 * Mirrors `ContactCustomFieldsCard` — the same frame, the same description, and
 * a label-plus-control pair per field, at the control height every branch of
 * `CustomFieldControl` resolves to.
 *
 * How many fields there are is data that has not arrived, so the count is
 * `CONTACT_CUSTOM_FIELD_SKELETON_COUNT` rather than a guess made here. Each row
 * is the same height whatever the type, which is what makes being one out cost
 * a row rather than a redesign.
 *
 * Its own file, because the lazy boundary imports it statically as its fallback.
 *
 * Changed in the same commit as the card it stands in for.
 */
export function ContactCustomFieldsCardSkeleton({ canWrite = true }: { canWrite?: boolean }) {
  const content = useContent();

  return (
    <SectionCard
      id="custom-fields"
      title={content.contacts.customFieldsHeading}
      description={
        canWrite ? content.contacts.customFieldsDescription : content.contacts.readOnlyHint
      }
    >
      <Stack gap="4">
        <LoadingAnnouncement label={content.contacts.customFieldsLoading} />

        {Array.from({ length: CONTACT_CUSTOM_FIELD_SKELETON_COUNT }, (_unused, index) => (
          <Stack key={index} gap="1">
            <SkeletonLine width="8rem" />
            {canWrite ? (
              <SkeletonLine height="var(--size-control-md)" />
            ) : (
              <SkeletonLine width="60%" />
            )}
          </Stack>
        ))}

        {canWrite ? (
          <Cluster justify="end">
            <SkeletonLine width="8rem" height="var(--size-control-md)" />
          </Cluster>
        ) : null}
      </Stack>
    </SectionCard>
  );
}
