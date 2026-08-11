import { Stack } from '@/components/layout/Stack';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonForText } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import styles from './EmbeddedSignupPanel.module.css';

/**
 * Mirrors `EmbeddedSignupPanel` in its idle state — same stack and gap, same
 * intro paragraph, same action row — so the lazy boundary hands over without the
 * card changing height.
 *
 * Both placeholders are measured from the real copy rather than given a width:
 * the intro wraps to three lines on a phone and one on a laptop, and the button
 * is as wide as its label, so a guessed width would be wrong at some viewport and
 * the section would jump there. `SkeletonForText` renders the string invisibly and
 * shimmers over the box it occupies, which is the same box the real text takes.
 *
 * Changed in the same commit as the panel it stands in for. A skeleton that has
 * drifted is a bug, not a cosmetic issue.
 */
export function EmbeddedSignupPanelSkeleton() {
  const content = useContent();

  return (
    <Stack gap="4">
      <LoadingAnnouncement label={content.whatsapp.loading} />
      <p className={styles.intro}>
        <SkeletonForText>{content.whatsapp.connectIntro}</SkeletonForText>
      </p>
      <div className={styles.actions}>
        <span aria-hidden="true" className={styles.actionPlaceholder}>
          <SkeletonForText>{content.whatsapp.connectButton}</SkeletonForText>
        </span>
      </div>
    </Stack>
  );
}
