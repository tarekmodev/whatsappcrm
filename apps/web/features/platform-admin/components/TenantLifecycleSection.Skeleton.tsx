import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { TenantTrailTableSkeleton } from './TenantTrailTable';

/**
 * What the tenant screen looks like while its trail is in flight.
 *
 * It renders the *same three `SectionCard`s* with the same headings, the same
 * descriptions and the same gaps as `TenantLifecycleSection`, so the swap to real
 * content moves nothing. The headings and the two notices are real text rather
 * than placeholders — they are copy this component already knows, and a shimmer
 * where a known sentence goes is a placeholder standing in for itself.
 *
 * The trail's placeholder is the real table's own skeleton, built from the real
 * column set, so it cannot drift when a column is added.
 *
 * One polite announcement for the whole region; every placeholder below is
 * `aria-hidden` by construction, so a screen reader hears one sentence rather
 * than a hundred boxes.
 */
export function TenantLifecycleSectionSkeleton() {
  const copy = content.platformAdmin.tenant;

  return (
    <Stack gap="5">
      <LoadingAnnouncement label={copy.loading} />

      <SectionCard id="tenant-state" title={copy.stateHeading} description={copy.stateDescription}>
        <Stack gap="5">
          <Stack gap="3">
            {/* Two `DetailList` rows: a term and its value, twice. Sized by the
                copy the real panel puts there, so the card is the same height. */}
            <SkeletonForText>{copy.statusLabel}</SkeletonForText>
            <SkeletonForText>{copy.lastChangedLabel}</SkeletonForText>
          </Stack>
          <Cluster gap="3">
            <SkeletonLine width="var(--size-action)" height="var(--size-control-md)" />
            <SkeletonLine width="var(--size-action)" height="var(--size-control-md)" />
          </Cluster>
          <Notice tone="info" variant="quiet">
            {copy.unbuiltActionsNotice}
          </Notice>
          <Notice tone="info" variant="quiet">
            {copy.impersonateNotice}
          </Notice>
        </Stack>
      </SectionCard>

      <SectionCard id="tenant-plan" title={copy.planHeading}>
        <Notice tone="info" variant="quiet">
          {copy.planNotice}
        </Notice>
      </SectionCard>

      <SectionCard id="tenant-trail" title={copy.trailHeading} description={copy.trailDescription}>
        <TenantTrailTableSkeleton />
      </SectionCard>
    </Stack>
  );
}
