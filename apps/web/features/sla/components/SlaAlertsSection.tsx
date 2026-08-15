import { Icon } from '@/components/ui/Icon';
import { loadSlaAlertSummary } from '@/features/sla/sla-alerts.data';
import { SlaAlertsMenu } from './SlaAlertsMenu';
import styles from './SlaAlertsMenu.module.css';

/**
 * Reads how many alerts are waiting and hands the number to the bell. Usage:
 * inside a Suspense boundary in the top bar, with `SlaAlertsSectionSkeleton` as
 * the fallback.
 *
 * The read is here rather than in the layout so the shell paints without waiting
 * on it — a bar that blocked on a notification count would delay every route's
 * first paint for a badge nobody is looking at yet.
 *
 * `loadSlaAlertSummary`, deliberately, not `loadSlaAlerts`: this renders on every
 * route, and the fuller read joins the user and team directories to put a name on
 * each alert's holder. The bell shows a number. The panel is where the names are
 * worth fetching, and the panel is lazy.
 *
 * Only the count crosses into the client, which is what keeps twenty alerts out
 * of the RSC payload of every page in the console.
 */
export async function SlaAlertsSection() {
  const { count, hasMore } = await loadSlaAlertSummary();

  return <SlaAlertsMenu count={count} hasMore={hasMore} />;
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
