'use client';

import type { CSSProperties } from 'react';
import type { DailyPoint } from '@whatsappcrm/contracts';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { EmptyState } from '@/components/ui/EmptyState';
import { useContent } from '@/lib/content';
import { formatReportDayLabel } from '@/features/reports/presentation';
import styles from './DailyVolumeChart.module.css';

/**
 * Opened against resolved, one pair of bars per tenant-local day. Usage:
 * `<DailyVolumeChart series={response.series} />`.
 *
 * It answers the one question the five headline figures cannot: *when* in the
 * range the work arrived and whether it was cleared as it did. Two totals that
 * match can hide a week of nothing followed by a weekend of everything.
 *
 * **No charting library.** Two bars in a grid is something CSS does natively, and
 * the smallest chart dependency in this ecosystem would cost more JavaScript than
 * the rest of this route put together.
 *
 * It is a client component for one reason — it is lazily imported, and
 * `next/dynamic` in a client boundary can only load client components — and for
 * none of the usual ones: it has no state, no effects and no handlers.
 *
 * Accessibility is not the tooltip. Every day carries its own figures as text
 * for a screen reader, the scroller is focusable so a keyboard can reach the days
 * that are off-screen, and the two series are told apart by a labelled legend
 * rather than by colour.
 */
export function DailyVolumeChart({ series }: { series: readonly DailyPoint[] }) {
  const content = useContent();
  const peak = Math.max(0, ...series.map((point) => Math.max(point.created, point.resolved)));

  if (peak === 0) {
    return (
      <EmptyState
        heading={content.reports.seriesEmptyHeading}
        body={content.reports.seriesEmptyBody}
      />
    );
  }

  const first = series.at(0);
  const last = series.at(-1);

  return (
    <div className={styles.chart}>
      <p className={styles.legend}>
        <span className={styles.legendItem}>
          <span aria-hidden="true" className={styles.swatch} data-series="created" />
          {content.reports.seriesCreatedLegend}
        </span>
        <span className={styles.legendItem}>
          <span aria-hidden="true" className={styles.swatch} data-series="resolved" />
          {content.reports.seriesResolvedLegend}
        </span>
      </p>

      {/* Focusable so the days past the right-hand edge are reachable without a
          pointer; labelled so it is not an unnamed tab stop. */}
      <div
        className={styles.scroller}
        tabIndex={0}
        role="group"
        aria-label={content.reports.seriesHeading}
      >
        <ul className={styles.days}>
          {series.map((point) => (
            <li key={point.date} className={styles.day}>
              <VisuallyHidden>
                {content.reports.seriesDayLabel(
                  formatReportDayLabel(point.date, content),
                  point.created,
                  point.resolved,
                )}
              </VisuallyHidden>
              <Bar value={point.created} peak={peak} series="created" />
              <Bar value={point.resolved} peak={peak} series="resolved" />
            </li>
          ))}
        </ul>
      </div>

      {/* The range's ends rather than a label under every bar: ninety labels do
          not fit a phone, and the figures a reader needs are in the table. */}
      <p className={styles.axis}>
        <span>{first === undefined ? null : formatReportDayLabel(first.date, content)}</span>
        <span>{last === undefined ? null : formatReportDayLabel(last.date, content)}</span>
      </p>
    </div>
  );
}

/**
 * One series' bar for one day.
 *
 * A zero keeps its slot and draws nothing. Omitting the element instead would let
 * the other bar take the whole column, so a day with two openings and no
 * resolutions would look twice as busy as a day with two of each.
 */
function Bar({
  value,
  peak,
  series,
}: {
  value: number;
  peak: number;
  series: 'created' | 'resolved';
}) {
  return (
    <span
      aria-hidden="true"
      className={styles.bar}
      data-series={series}
      data-empty={value === 0 ? 'true' : undefined}
      style={{ '--bar-fill': value / peak } as CSSProperties}
    />
  );
}
