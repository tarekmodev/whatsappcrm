import { Stack } from '@/components/layout/Stack';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonBlock, SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { BrandingPreviewSkeleton } from './BrandingPreview.Skeleton';
import assetStyles from './BrandingAssetCard.module.css';
import formStyles from './BrandingForm.module.css';
import styles from './BrandingSections.module.css';

/**
 * Mirrors `BrandingSections` — the same two cards, the same field stack, the same
 * colour grid, the same preview and the same pair of asset boxes — so the route's
 * `loading.tsx` hands over without anything changing height.
 *
 * It imports the **real components' module files** rather than drawing an
 * approximation out of fixed boxes: `.colours`, `.assets` and `.preview` are the
 * grids the loaded page uses, so a change to either lands here in the same commit
 * or the layouts stop matching in a way a test can catch.
 *
 * One polite announcement for the whole screen (`LoadingAnnouncement`), not one
 * per placeholder — the shimmering nodes are all `aria-hidden`.
 */
export function BrandingSectionsSkeleton() {
  const content = useContent();

  return (
    <Stack gap="5">
      <LoadingAnnouncement label={content.branding.loading} />

      <SectionCard
        title={content.branding.coloursHeading}
        description={content.branding.coloursDescription}
      >
        <Stack gap="5">
          <SkeletonField label={content.branding.productNameLabel} />
          <SkeletonField label={content.branding.supportEmailLabel} />
          <div className={formStyles.colours}>
            <div className={formStyles.colourField}>
              <SkeletonField label={content.branding.primaryColorLabel} />
            </div>
            <div className={formStyles.colourField}>
              <SkeletonField label={content.branding.accentColorLabel} />
            </div>
          </div>
          <div>
            <h3 className={formStyles.previewHeading}>{content.branding.previewHeading}</h3>
            <p className={formStyles.previewDescription}>{content.branding.previewDescription}</p>
            <BrandingPreviewSkeleton />
          </div>
          <div className={formStyles.actions}>
            <span aria-hidden="true" className={styles.actionPlaceholder}>
              <SkeletonForText>{content.common.save}</SkeletonForText>
            </span>
          </div>
        </Stack>
      </SectionCard>

      <SectionCard
        title={content.branding.assetsHeading}
        description={content.branding.assetsDescription}
      >
        <div className={styles.assets}>
          <SkeletonAssetCard label={content.branding.logoLabel} tone="rail" />
          <SkeletonAssetCard label={content.branding.faviconLabel} tone="surface" />
        </div>
      </SectionCard>
    </Stack>
  );
}

/**
 * A label plus a control-height box — the shape every `Field` in the form
 * resolves to. The label is the real string, so the placeholder wraps exactly
 * where the loaded one will.
 */
function SkeletonField({ label }: { label: string }) {
  return (
    <Stack gap="2">
      <SkeletonForText>{label}</SkeletonForText>
      <SkeletonBlock height="var(--size-control-md)" />
    </Stack>
  );
}

function SkeletonAssetCard({ label, tone }: { label: string; tone: 'surface' | 'rail' }) {
  const content = useContent();

  return (
    <Stack gap="3">
      <div className={assetStyles.card}>
        <div className={assetStyles.preview} data-tone={tone} />
        <p className={assetStyles.meta}>
          <SkeletonLine width="10rem" />
        </p>
      </div>
      <SkeletonField label={content.branding.chooseFile(label)} />
      <div className={assetStyles.actions}>
        <span aria-hidden="true" className={styles.actionPlaceholder}>
          <SkeletonForText>{content.common.save}</SkeletonForText>
        </span>
      </div>
    </Stack>
  );
}
