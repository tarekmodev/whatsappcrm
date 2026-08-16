import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { content } from '@/content/en';
import { SERIES_SKELETON_BARS } from '@/features/reports/constants';
import styles from './DailyVolumeChart.module.css';

/**
 * The chart's placeholder, and the fallback `LazyDailyVolumeChart` shows while
 * its chunk is in flight.
 *
 * A file of its own, and that is the point: it is imported eagerly by the lazy
 * boundary, so anything it pulled in would land in the route's own bundle. It
 * shares `DailyVolumeChart.module.css` rather than the chart component — the
 * classes are the contract, so the track height, the column widths and the
 * legend cannot drift between the two.
 *
 * The legend is the **real** legend: it renders from the content layer, so there
 * is nothing about it to wait for, and drawing a shimmer over two words already
 * in the bundle would be slower and emptier. Only the bars are unknown.
 */
export function DailyVolumeChartSkeleton() {
  return (
    <div className={styles.chart}>
      <LoadingAnnouncement label={content.reports.seriesLoading} />
      <p className={styles.legend} aria-hidden="true">
        <span className={styles.legendItem}>
          <span className={styles.swatch} data-series="created" />
          {content.reports.seriesCreatedLegend}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatch} data-series="resolved" />
          {content.reports.seriesResolvedLegend}
        </span>
      </p>
      <div className={styles.scroller}>
        <ul className={styles.days} aria-hidden="true">
          {Array.from({ length: SERIES_SKELETON_BARS }, (_unused, index) => (
            <li key={index} className={styles.day}>
              <SkeletonLine
                width="100%"
                height={PLACEHOLDER_HEIGHTS[index % PLACEHOLDER_HEIGHTS.length]}
              />
            </li>
          ))}
        </ul>
      </div>
      {/* Empty, but present: the axis line is a row of the chart's height, and a
          placeholder without it would be a row short and shift on arrival. */}
      <p className={styles.axis} aria-hidden="true">
        <SkeletonLine width="4rem" />
        <SkeletonLine width="4rem" />
      </p>
    </div>
  );
}

/**
 * A repeating profile rather than random heights. A skeleton has to render the
 * same on the server and on the client, and `Math.random()` in a component is a
 * hydration mismatch waiting for a slow network.
 */
const PLACEHOLDER_HEIGHTS = ['40%', '70%', '55%', '85%', '35%', '60%'];
