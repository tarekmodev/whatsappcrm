import { Cluster } from '@/components/layout/Cluster';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import styles from './ContactsFilterBar.module.css';

/**
 * The filter bar's placeholder, while the tag vocabulary is in flight.
 *
 * Reuses the bar's own module CSS, so the two boxes are the same widths at the
 * same breakpoints and the list below never moves when the real controls arrive.
 * Height is `--size-control-md`, which is what a `TextInput` and a `Select` both
 * resolve to.
 *
 * No `LoadingAnnouncement` here on purpose: the list beside it already makes one
 * polite announcement, and two would talk over each other.
 */
export function ContactsFilterBarSkeleton() {
  return (
    <Cluster gap="3" align="start" className={styles.bar}>
      <div className={styles.search}>
        <SkeletonBlock height="var(--size-control-md)" />
      </div>
      <div className={styles.tag}>
        <SkeletonBlock height="var(--size-control-md)" />
      </div>
    </Cluster>
  );
}
