import { RelativeTime } from '@/components/ui/RelativeTime';
import { Badge } from '@/components/ui/Badge';
import { content } from '@/content/en';
import { SLA_COUNTDOWN_REFRESH_MS } from '@/features/sla/constants';
import type { SlaIndicatorModel } from '@/features/sla/presentation';
import styles from './SlaIndicator.module.css';

/**
 * Where one SLA timer stands. Usage:
 * `<SlaIndicator indicator={firstResponseIndicator(ticket.sla)} />`.
 *
 * The badge carries the state in words — Overdue, Due, Paused, Met — and the
 * time beside it is the *deadline*, rendered relative. Colour never conveys the
 * state on its own, which is what lets the same component sit in a queue row, a
 * ticket header and an alert row without a forced-colors variant.
 *
 * A running timer re-phrases itself on `SLA_COUNTDOWN_REFRESH_MS`; a settled one
 * does not, so a queue of met tickets keeps no timers alive. `RelativeTime`
 * renders the absolute value on the server and upgrades after mount, so nothing
 * here can produce a hydration mismatch.
 *
 * `indicator` may be `null` — that is the tenant with no SLA policy, and it
 * renders muted copy rather than an empty cell, because a stacked table row on a
 * phone repeats its column header beside the value and a blank one reads as
 * missing data.
 */
export function SlaIndicator({ indicator }: { indicator: SlaIndicatorModel | null }) {
  if (indicator === null) {
    return <span className={styles.none}>{content.sla.notApplicable}</span>;
  }

  return (
    <span className={styles.indicator} data-state={indicator.state}>
      <Badge tone={indicator.tone}>{indicator.label}</Badge>
      <RelativeTime
        isoTimestamp={indicator.dueAt}
        label={indicator.deadlineLabel}
        refreshMs={indicator.isCounting ? SLA_COUNTDOWN_REFRESH_MS : undefined}
      />
    </span>
  );
}
