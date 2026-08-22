import type { CSSProperties, ReactNode } from 'react';
import styles from './DailyVolumeChart.module.css';

/**
 * The daily-volume chart's value axis: hairline gridlines across the plotting
 * area, each labelled in the gutter beside it. Usage:
 *
 * ```tsx
 * <ChartValueAxis axisLabel="Tickets" lines={scale.ticks.map(…)} />
 * ```
 *
 * Its own component because the chart and its skeleton both draw it, and because
 * "a rule at a fraction of the track's height" is one thing to get right rather
 * than two. It is `aria-hidden` in full: a screen reader gets each day's figures
 * as text from the columns themselves, and reading out four gridline values
 * before them would be a preamble nobody asked for.
 *
 * The lines are positioned from the **baseline** up, in percentages of the
 * track, so they land wherever the track's height token puts them and need no
 * measurement.
 */

export interface ChartGridline {
  readonly id: string;
  /** Height up the track, `0`–`1`. */
  readonly fraction: number;
  readonly label: ReactNode;
}

export function ChartValueAxis({
  lines,
  axisLabel,
}: {
  lines: readonly ChartGridline[];
  axisLabel: string;
}) {
  return (
    <div className={styles.valueAxis} aria-hidden="true">
      <span className={styles.valueAxisLabel}>{axisLabel}</span>
      {lines.map((line) => (
        <span
          key={line.id}
          className={styles.gridline}
          style={{ '--gridline-fill': line.fraction } as CSSProperties}
        >
          <span className={styles.gridlineLabel}>{line.label}</span>
        </span>
      ))}
    </div>
  );
}
