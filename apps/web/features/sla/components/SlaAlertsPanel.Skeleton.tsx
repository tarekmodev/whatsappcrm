import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { content } from '@/content/en';
import { SLA_ALERTS_SKELETON_COUNT } from '@/features/sla/constants';
import rowStyles from './SlaAlertRow.module.css';
import styles from './SlaAlertsPanel.module.css';

/**
 * The alert panel's placeholder, and the fallback `LazySlaAlertsPanel` shows
 * while its chunk is in flight.
 *
 * A file of its own, and that is the point: it is imported eagerly by the lazy
 * boundary, so anything it pulled in would land in the shell's bundle. Sharing
 * `SlaAlertRow.module.css` rather than the row component is what keeps the two
 * the same height without importing the row — the classes are the contract, so a
 * row that changes shape changes both.
 */
export function SlaAlertsPanelSkeleton() {
  return (
    <div className={styles.panel}>
      <LoadingAnnouncement label={content.sla.alertsLoading} />
      <ul className={styles.list}>
        {Array.from({ length: SLA_ALERTS_SKELETON_COUNT }, (_unused, index) => (
          <li key={index} className={rowStyles.row} aria-hidden="true">
            <div className={rowStyles.body}>
              <SkeletonLine width="9rem" />
              <SkeletonLine width="12rem" />
            </div>
            <SkeletonLine width="5rem" height="var(--size-control-sm)" />
          </li>
        ))}
      </ul>
    </div>
  );
}
