'use client';

import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useContent } from '@/lib/content';
import { useSlaAlerts, type SlaAlertCountListener } from '@/features/sla/useSlaAlerts';
import { SlaAlertRow } from './SlaAlertRow';
import { SlaAlertsPanelSkeleton } from './SlaAlertsPanel.Skeleton';
import styles from './SlaAlertsPanel.module.css';

/**
 * The body of the supervisor's alert popup. Usage: behind
 * `LazySlaAlertsPanel`, inside `SlaAlertsMenu`.
 *
 * Loaded on first open rather than with the shell — see `sla-alerts.lazy.tsx`
 * for why — and it reads on mount, so opening the popup twice shows what is
 * true now rather than what was true when the page was rendered.
 *
 * All four states are here and none of them is a blank box: a structure-matching
 * skeleton, the list, an empty state that says the queue is clear, and an error
 * with a retry that can actually succeed.
 */
export function SlaAlertsPanel({ onCountChange }: { onCountChange: SlaAlertCountListener }) {
  const content = useContent();
  const { state, pendingAlertId, acknowledge, retry } = useSlaAlerts(onCountChange);

  if (state.status === 'loading') {
    return <SlaAlertsPanelSkeleton />;
  }

  if (state.status === 'failed') {
    return (
      <div className={styles.panel}>
        <ErrorState onRetry={retry} description={state.message} />
      </div>
    );
  }

  if (state.alerts.length === 0) {
    return (
      <div className={styles.panel}>
        <EmptyState
          icon="alert"
          title={content.sla.emptyHeading}
          description={content.sla.emptyBody}
        />
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <ul className={styles.list}>
        {state.alerts.map((alert) => (
          <SlaAlertRow
            key={alert.id}
            alert={alert}
            onAcknowledge={acknowledge}
            isPending={pendingAlertId === alert.id}
          />
        ))}
      </ul>
      {state.hasMore ? <p className={styles.more}>{content.sla.moreAlerts}</p> : null}
    </div>
  );
}
