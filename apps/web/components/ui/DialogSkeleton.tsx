import { SkeletonBlock, SkeletonLine } from './Skeleton';
import styles from './DialogSkeleton.module.css';

/**
 * The fallback for a lazily-imported dialog. Usage: as `next/dynamic`'s `loading`
 * option.
 *
 * Mirrors `Modal`'s frame — scrim, header line, body block, footer row — so the
 * dialog's own chunk arriving does not resize or reposition the panel.
 */
export function DialogSkeleton() {
  return (
    <div className={styles.scrim} aria-hidden="true">
      <div className={styles.panel}>
        <div className={styles.header}>
          <SkeletonLine width="12rem" height="1.25rem" />
        </div>
        <div className={styles.body}>
          <SkeletonBlock height="var(--space-7)" />
          <SkeletonBlock height="var(--space-7)" />
        </div>
        <div className={styles.footer}>
          <SkeletonLine width="6rem" height="var(--size-touch-target)" />
          <SkeletonLine width="8rem" height="var(--size-touch-target)" />
        </div>
      </div>
    </div>
  );
}
