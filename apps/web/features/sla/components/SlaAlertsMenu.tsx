'use client';

import { useCallback, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { MenuButton } from '@/components/ui/MenuButton';
import { useContent } from '@/lib/content';
import { SLA_ALERTS_PAGE_SIZE } from '@/features/sla/constants';
import type { SlaAlertCountListener } from '@/features/sla/useSlaAlerts';
import { LazySlaAlertsPanel } from './sla-alerts.lazy';
import styles from './SlaAlertsMenu.module.css';

/**
 * The supervisor's SLA alert bell. Usage: `<SlaAlertsMenu count={…} hasMore={…} />`
 * from `SlaAlertsSection`, in the console's top bar.
 *
 * Rendered only for a principal holding `sla:read` — a role that can never be an
 * alert recipient is not given an affordance that would always be empty. That
 * gate is UX: `GET /sla-alerts` narrows to the calling principal server-side, so
 * an agent who reached this anyway would see their own empty page.
 *
 * ## Where the count comes from
 *
 * The server render seeds it, and the panel takes it over from its first read.
 * Two things then keep it honest: acknowledging updates it here, in the bell,
 * which outlives the panel — a count held inside the popup would snap back to
 * the server's stale value every time somebody closed it. And a `sla.breached`
 * event refreshes the route, which re-renders this layout with a new `count`;
 * the reconciliation below is what adopts it without losing an acknowledgement
 * made a moment earlier.
 *
 * `MenuButton` owns the popup behaviour: `aria-expanded`, focus moved in on open
 * and back to the trigger on close, Escape, click-outside, and close on route
 * change.
 */

export interface SlaAlertsMenuProps {
  /** Unacknowledged alerts as of the last server render. */
  count: number;
  /** True when there were more than one page of them; the bell shows "20+". */
  hasMore: boolean;
}

interface Summary {
  count: number;
  hasMore: boolean;
}

export function SlaAlertsMenu({ count, hasMore }: SlaAlertsMenuProps) {
  const content = useContent();
  const [summary, setSummary] = useState<Summary>({ count, hasMore });
  // React's documented way to adopt a new prop without an effect: compare
  // against what the last render was given, and reset during render rather than
  // after paint — which would show the stale count for a frame.
  const [serverSummary, setServerSummary] = useState<Summary>({ count, hasMore });

  if (serverSummary.count !== count || serverSummary.hasMore !== hasMore) {
    setServerSummary({ count, hasMore });
    setSummary({ count, hasMore });
  }

  const onCountChange = useCallback<SlaAlertCountListener>((nextCount, nextHasMore) => {
    setSummary({ count: nextCount, hasMore: nextHasMore });
  }, []);

  const badge = summary.count === 0 ? null : formatCount(summary.count, summary.hasMore);

  return (
    <MenuButton
      align="end"
      className={styles.menu}
      triggerClassName={styles.trigger}
      accessibleName={
        badge === null ? content.sla.alertsNoneAria : content.sla.alertsAria(summary.count)
      }
      label={
        <>
          <Icon name="alert" />
          {/*
            The count is decoration: the trigger's accessible name already says
            how many there are, so announcing the number twice would be noise —
            and a bell with no badge is not "zero alerts" to a screen reader, it
            is silence.
          */}
          {badge === null ? null : (
            <span className={styles.count} aria-hidden="true">
              {badge}
            </span>
          )}
        </>
      }
    >
      <LazySlaAlertsPanel onCountChange={onCountChange} />
    </MenuButton>
  );
}

/**
 * "20+" rather than a number the console would have to page the whole table to
 * know. The API answers one page; claiming an exact total from it would be a
 * guess dressed as a figure.
 */
function formatCount(count: number, hasMore: boolean): string {
  return hasMore ? `${String(SLA_ALERTS_PAGE_SIZE)}+` : String(count);
}
