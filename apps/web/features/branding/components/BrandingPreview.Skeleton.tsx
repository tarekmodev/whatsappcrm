import { Stack } from '@/components/layout/Stack';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import styles from './BrandingPreview.module.css';

/**
 * Mirrors `BrandingPreview` — the same wrapper, the same action row, the same
 * paragraph and the same decorative band — so the lazy boundary hands over
 * without the card changing height at any width.
 *
 * It imports the **same module file** rather than approximating the layout with
 * fixed boxes, which is what keeps the two from drifting: a rule added to the
 * real panel lands here in the same commit or not at all.
 *
 * The two action placeholders are measured from the real labels through
 * `SkeletonForText`, because a button is as wide as its copy and a guessed width
 * would be wrong in some locale.
 */
export function BrandingPreviewSkeleton() {
  const content = useContent();

  return (
    <div className={styles.preview}>
      <LoadingAnnouncement label={content.branding.loading} />
      <Stack gap="4">
        <div className={styles.actions}>
          <span aria-hidden="true" className={styles.primaryAction}>
            <SkeletonForText>{content.branding.previewButton}</SkeletonForText>
          </span>
          <span aria-hidden="true" className={styles.secondaryAction}>
            <SkeletonForText>{content.branding.previewSecondaryButton}</SkeletonForText>
          </span>
          <span aria-hidden="true" className={styles.badge}>
            <SkeletonForText>{content.branding.previewBadge}</SkeletonForText>
          </span>
        </div>
        <p className={styles.body}>
          <SkeletonForText>{content.branding.previewBodyText}</SkeletonForText>
        </p>
        <SkeletonLine height="var(--space-3)" />
      </Stack>
    </div>
  );
}
