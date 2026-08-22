import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { content } from '@/content/en';
import { SERIES_SKELETON_BARS, SERIES_SKELETON_GRIDLINES } from '@/features/reports/constants';
import { ChartLegend } from './ChartLegend';
import { ChartValueAxis } from './ChartValueAxis';
import styles from './DailyVolumeChart.module.css';

/**
 * The chart's placeholder, and the fallback `LazyDailyVolumeChart` shows while
 * its chunk is in flight.
 *
 * A file of its own, and that is the point: it is imported eagerly by the lazy
 * boundary, so anything it pulled in would land in the route's own bundle. It
 * shares `DailyVolumeChart.module.css`, its legend and its value axis with the
 * chart itself — the classes and those two components are the contract, so the
 * gutter, the track height, the column widths and the legend cannot drift.
 *
 * The legend and the axis label are the **real** ones: they render from the
 * content layer, so there is nothing about them to wait for, and drawing a
 * shimmer over two words already in the bundle would be slower and emptier. Only
 * the figures are unknown.
 */
export function DailyVolumeChartSkeleton() {
  return (
    <div className={styles.chart}>
      <LoadingAnnouncement label={content.reports.seriesLoading} />
      <div aria-hidden="true">
        <ChartLegend />
      </div>

      <div className={styles.plot}>
        <ChartValueAxis
          axisLabel={content.reports.seriesValueAxisLabel}
          lines={Array.from({ length: SERIES_SKELETON_GRIDLINES }, (_unused, index) => ({
            id: String(index),
            fraction: index / (SERIES_SKELETON_GRIDLINES - 1),
            label: <SkeletonLine width="2ch" />,
          }))}
        />

        <div className={styles.scroller}>
          <ul className={styles.days} aria-hidden="true">
            {Array.from({ length: SERIES_SKELETON_BARS }, (_unused, index) => (
              <li key={index} className={styles.day}>
                <span className={styles.dayTarget}>
                  <SkeletonLine
                    width="100%"
                    height={PLACEHOLDER_HEIGHTS[index % PLACEHOLDER_HEIGHTS.length]}
                  />
                </span>
              </li>
            ))}
          </ul>

          {/* Empty, but present: the day axis is a row of the chart's height, and
              a placeholder without it would be a row short and shift on arrival. */}
          <ul className={styles.dayAxis} aria-hidden="true">
            <li className={styles.dayAxisCell}>
              <span className={styles.dayAxisLabel} data-anchor="start">
                <SkeletonLine width="4rem" />
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * A repeating profile rather than random heights. A skeleton has to render the
 * same on the server and on the client, and `Math.random()` in a component is a
 * hydration mismatch waiting for a slow network.
 */
const PLACEHOLDER_HEIGHTS = ['40%', '70%', '55%', '85%', '35%', '60%'];
