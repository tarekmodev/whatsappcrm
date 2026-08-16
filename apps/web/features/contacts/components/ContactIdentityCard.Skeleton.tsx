'use client';

import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { DetailList } from '@/components/ui/DetailList';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonCircle, SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';

/**
 * Mirrors `ContactIdentityCard` — the same frame, the same avatar-beside-name
 * cluster, and the same five-row `DetailList` rendered through the real
 * component, so the swap changes no height.
 *
 * The terms are the real strings, because they are copy this skeleton already
 * knows; only the values are placeholders, because they are data that has not
 * arrived. No opted-out notice: whether one appears depends on the data, and
 * reserving space for it would leave a gap on the common path.
 *
 * Changed in the same commit as the card it stands in for.
 */
export function ContactIdentityCardSkeleton() {
  const content = useContent();

  return (
    <SectionCard id="identity" title={content.contacts.identityHeading}>
      <Stack gap="4">
        <LoadingAnnouncement label={content.contacts.identityLoading} />

        <Cluster gap="3" align="center">
          <SkeletonCircle size="var(--size-control-md)" />
          <Stack gap="1">
            <SkeletonLine width="10rem" />
            <SkeletonLine width="7rem" />
          </Stack>
        </Cluster>

        <DetailList
          items={[
            {
              id: 'phone',
              term: content.contacts.phoneTerm,
              value: <SkeletonLine width="9rem" />,
            },
            {
              id: 'email',
              term: content.contacts.emailTerm,
              value: <SkeletonLine width="12rem" />,
            },
            {
              id: 'wa-profile-name',
              term: content.contacts.waProfileNameTerm,
              value: <SkeletonLine width="10rem" />,
            },
            {
              id: 'last-contacted',
              term: content.contacts.lastContactedTerm,
              value: <SkeletonLine width="6rem" />,
            },
            {
              id: 'created',
              term: content.contacts.createdTerm,
              value: <SkeletonLine width="6rem" />,
            },
          ]}
        />
      </Stack>
    </SectionCard>
  );
}
