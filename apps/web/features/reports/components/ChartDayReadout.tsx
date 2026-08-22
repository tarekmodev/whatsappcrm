import type { DailyPoint } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { formatCount, formatDuration, formatReportDayLabel } from '@/features/reports/presentation';
import { MeasuredDuration } from './MeasuredDuration';
import styles from './DailyVolumeChart.module.css';

/**
 * One day's figures, as the panel that appears over the hovered or focused
 * column. Usage: `<ChartDayReadout point={series[activeIndex]} />`.
 *
 * `aria-hidden`, and deliberately: the same figures are already the focused
 * column's accessible name, so a screen reader hears them once from the thing
 * the user is actually on rather than twice from two places.
 *
 * It carries the day's **median first response** as well as the two counts. That
 * figure is in the contract's daily point, was fetched on every load and drawn
 * nowhere — and it is the answer to the question a spike in the bars raises,
 * which is whether the day that got busy also got slower.
 */
export function ChartDayReadout({ point }: { point: DailyPoint }) {
  return (
    <div className={styles.readout} aria-hidden="true">
      <p className={styles.readoutDate}>{formatReportDayLabel(point.date, content)}</p>
      <dl className={styles.readoutList}>
        <div className={styles.readoutRow}>
          <dt className={styles.readoutTerm} data-series="created">
            {content.reports.seriesCreatedLegend}
          </dt>
          <dd className={styles.readoutValue}>{formatCount(point.created, content)}</dd>
        </div>
        <div className={styles.readoutRow}>
          <dt className={styles.readoutTerm} data-series="resolved">
            {content.reports.seriesResolvedLegend}
          </dt>
          <dd className={styles.readoutValue}>{formatCount(point.resolved, content)}</dd>
        </div>
        <div className={styles.readoutRow}>
          <dt className={styles.readoutTerm}>{content.reports.seriesResponseLabel}</dt>
          <dd className={styles.readoutValue}>
            <MeasuredDuration seconds={point.firstResponseMedianSeconds} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * The same day, as a sentence — the focused column's accessible name.
 *
 * A string rather than markup, because it is read by `aria-label`: a column
 * whose figures lived only in the panel above it would be a column a screen
 * reader could reach and learn nothing from.
 */
export function dayAccessibleLabel(point: DailyPoint): string {
  const date = formatReportDayLabel(point.date, content);

  if (point.firstResponseMedianSeconds === null) {
    return content.reports.seriesDayLabel(date, point.created, point.resolved);
  }

  return content.reports.seriesDayLabelWithResponse(
    date,
    point.created,
    point.resolved,
    formatDuration(point.firstResponseMedianSeconds, content),
  );
}
