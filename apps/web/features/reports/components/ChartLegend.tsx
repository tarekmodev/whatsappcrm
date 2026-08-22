import { content } from '@/content/en';
import styles from './DailyVolumeChart.module.css';

/**
 * The daily-volume chart's key. Usage: `<ChartLegend />`.
 *
 * Its own component because the chart and the chart's skeleton both draw it —
 * the legend is known copy, so the placeholder shows the real thing, and two
 * copies of this markup are how the two drift apart.
 *
 * **Three carriers, not one.** Each series has its own colour token, its own
 * swatch *shape*, and its own word. Colour is the fastest of the three to read
 * and the first to fail: a colour-vision-deficient reader, a greyscale print and
 * forced-colours mode each lose it, and the square-against-circle survives all
 * three. The bars repeat the same shape difference in their corner radius.
 */

export const CHART_SERIES = ['created', 'resolved'] as const;
export type ChartSeries = (typeof CHART_SERIES)[number];

export function ChartLegend() {
  return (
    <p className={styles.legend}>
      {CHART_SERIES.map((series) => (
        <span key={series} className={styles.legendItem}>
          <span aria-hidden="true" className={styles.swatch} data-series={series} />
          {SERIES_LABELS[series]}
        </span>
      ))}
    </p>
  );
}

const SERIES_LABELS: Record<ChartSeries, string> = {
  created: content.reports.seriesCreatedLegend,
  resolved: content.reports.seriesResolvedLegend,
};
