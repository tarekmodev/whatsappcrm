'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useContent } from '@/lib/content';
import type { SlaAlertView } from '@/features/sla/sla-alerts.data';
import styles from './SlaAlertRow.module.css';

/**
 * One breached ticket in the supervisor's alert panel. Usage:
 * `<SlaAlertRow alert={alert} onAcknowledge={…} isPending={…} />`.
 *
 * Presentational: it owns no request. The panel above it holds the list, so the
 * optimistic removal and its rollback live in one place rather than once per
 * row — a row that removed itself would have nothing left to roll back into.
 *
 * The whole row is not the link. Acknowledging and opening the ticket are two
 * different intentions, and nesting a button inside an anchor is invalid markup
 * that keyboard users experience as one control they cannot separate.
 */

export interface SlaAlertRowProps {
  alert: SlaAlertView;
  onAcknowledge: (alertId: string) => void;
  /** True while this row's acknowledgement is in flight — not the panel's. */
  isPending: boolean;
}

export function SlaAlertRow({ alert, onAcknowledge, isPending }: SlaAlertRowProps) {
  const content = useContent();
  const reference = content.tickets.reference(alert.ticketNumber);

  return (
    <li className={styles.row}>
      <div className={styles.body}>
        <Link className={styles.link} href={alert.href}>
          {/* `dir="ltr"`: a reference number reads left to right whatever the
              surrounding text direction is. */}
          <span className={styles.reference} dir="ltr">
            {reference}
          </span>
          <span className={styles.kind}>{content.sla.kinds[alert.kind]}</span>
        </Link>
        <p className={styles.meta}>
          <span>{alert.holderLabel}</span>
          <span aria-hidden="true">·</span>
          <RelativeTime isoTimestamp={alert.dueAt} label={content.sla.missedDeadline} />
        </p>
      </div>

      <Button
        size="sm"
        variant="ghost"
        isPending={isPending}
        aria-label={content.sla.acknowledgeAria(reference)}
        onClick={() => {
          onAcknowledge(alert.id);
        }}
      >
        {content.sla.acknowledge}
      </Button>
    </li>
  );
}
