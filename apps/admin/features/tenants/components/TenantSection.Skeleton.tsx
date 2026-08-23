import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { content } from '~/content/en';
import { TenantTrailTableSkeleton } from './TenantTrailTable';

/**
 * What the tenant screen looks like while its trail is in flight.
 *
 * The same header and the same two cards as `TenantSection`, at the same heights,
 * so the swap moves nothing. The headings and the two notices are the real copy
 * rather than placeholders — they are strings this component already knows, and a
 * shimmer where a known sentence goes is a placeholder standing in for itself.
 *
 * The `<h1>` is a placeholder because the slug genuinely is not rendered until the
 * section has it, and `PageHeader` takes a string.
 *
 * One polite announcement for the whole region; every placeholder below is
 * `aria-hidden` by construction, so a screen reader hears one sentence rather than
 * a hundred boxes.
 */
export function TenantSectionSkeleton() {
  return (
    <Stack gap="5">
      <LoadingAnnouncement label={content.tenant.loading} />
      <PageHeader title="\u00a0" subtitle={content.tenant.subtitle} />

      <SectionCard id="lifecycle" title={content.tenant.lifecycleHeading}>
        <Stack gap="4">
          <Stack gap="3">
            {/* Two `DetailList` rows: a term and its value, twice. Sized by the
                copy the real panel puts there, so the card is the same height. */}
            <SkeletonForText>{content.tenant.columns.change}</SkeletonForText>
            <SkeletonForText>{content.tenant.columns.when}</SkeletonForText>
          </Stack>
          <Notice tone="info" variant="quiet">
            {content.tenant.lifecycleUnknown}
          </Notice>
          <Notice tone="info" variant="quiet">
            {content.tenant.impersonateNotice}
          </Notice>
        </Stack>
      </SectionCard>

      <SectionCard
        id="history"
        title={content.tenant.historyHeading}
        description={<SkeletonLine width="8rem" />}
      >
        <TenantTrailTableSkeleton />
      </SectionCard>
    </Stack>
  );
}
