import { Icon } from '@/components/ui/Icon';
import { loadSlaAlerts } from '@/features/sla/sla-alerts.data';
import { SlaAlertsMenu } from './SlaAlertsMenu';
import styles from './SlaAlertsMenu.module.css';

/**
 * Reads the supervisor's unacknowledged alerts and hands the count to the bell.
 * Usage: inside a Suspense boundary in the top bar, with
 * `SlaAlertsSectionSkeleton` as the fallback.
 *
 * The read is here rather than in the layout so the shell paints without waiting
 * on it — a bar that blocked on a notification count would delay every route's
 * first paint for a badge nobody is looking at yet.
 *
 * Only the count crosses into the client. The rows themselves are fetched by the
 * panel when it opens, which is what keeps twenty alerts out of the RSC payload
 * of every page in the console.
 */
export async function SlaAlertsSection() {
  const { alerts, hasMore } = await loadSlaAlerts();

  return <SlaAlertsMenu count={alerts.length} hasMore={hasMore} />;
}

/**
 * The bell without its count: the same icon at the same size in the same box, so
 * the badge arriving never moves the controls beside it.
 *
 * Not a shimmer. A one-glyph placeholder pulsing in the top bar of every page
 * would be the most distracting thing on screen, and the thing it stands in for
 * is a number that is usually zero.
 */
export function SlaAlertsSectionSkeleton() {
  return (
    <span className={styles.triggerPlaceholder} aria-hidden="true">
      <Icon name="alert" />
    </span>
  );
}
