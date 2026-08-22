'use client';

import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { DailyPoint } from '@whatsappcrm/contracts';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { EmptyState } from '@/components/ui/EmptyState';
import { useContent } from '@/lib/content';
import { barFraction, chartScale, dayLabelIndexes } from '@/features/reports/chart-scale';
import { MAX_STAGGERED_COLUMNS } from '@/features/reports/constants';
import { formatCount, formatReportDayLabel } from '@/features/reports/presentation';
import { ChartDayReadout, dayAccessibleLabel } from './ChartDayReadout';
import { ChartLegend } from './ChartLegend';
import { ChartValueAxis } from './ChartValueAxis';
import styles from './DailyVolumeChart.module.css';

/**
 * Opened against resolved, one pair of bars per tenant-local day. Usage:
 * `<DailyVolumeChart series={response.series} />`.
 *
 * It answers the one question the five headline figures cannot: *when* in the
 * range the work arrived, and whether it was cleared as it did. Two totals that
 * match can hide a week of nothing followed by a weekend of everything.
 *
 * **No charting library.** Two bars in a grid, a few absolutely positioned rules
 * and a panel is something CSS does natively, and the smallest chart dependency
 * in this ecosystem would cost more JavaScript than the rest of this route put
 * together. What TAR-519 added — a labelled value axis, dated columns, a per-day
 * readout and arrow-key navigation — is what a library would have been bought
 * for, and none of it needed one.
 *
 * **Accessibility is not the readout.** Every day is a focusable graphic whose
 * accessible name is its own figures, so a screen reader gets the same numbers
 * the panel shows; the arrow keys move between them, one Tab stop for the whole
 * chart; and the two series are told apart by shape and by a labelled legend as
 * well as by colour, which is the part that fails first.
 */
export function DailyVolumeChart({ series }: { series: readonly DailyPoint[] }) {
  const content = useContent();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Which day owns the chart's single tab stop. Separate from `activeIndex` on
  // purpose: hovering a column shows its figures without moving the tab stop out
  // from under a keyboard user.
  const [focusIndex, setFocusIndex] = useState(0);
  const dayRefs = useRef<(HTMLElement | null)[]>([]);
  const readoutRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  /**
   * Puts the readout over the active column. Written straight onto the node as a
   * custom property rather than held in state, for the reason `MenuButton`
   * documents: it is measured geometry, so a render round trip would show the
   * panel in the wrong place first.
   *
   * A physical offset, not a logical one — it comes from the element's own box,
   * so it is already correct under `dir="rtl"` with no side to mirror.
   */
  const positionReadout = useCallback(() => {
    const readout = readoutRef.current;
    const plot = plotRef.current;
    const column = activeIndex === null ? null : dayRefs.current[activeIndex];

    if (readout === null || plot === null || column == null) {
      return;
    }

    const columnBox = column.getBoundingClientRect();
    const plotBox = plot.getBoundingClientRect();

    readout.style.setProperty(
      '--readout-x',
      `${String(Math.round(columnBox.left + columnBox.width / 2 - plotBox.left))}px`,
    );
  }, [activeIndex]);

  useLayoutEffect(positionReadout, [positionReadout]);

  const peak = Math.max(0, ...series.map((point) => Math.max(point.created, point.resolved)));

  if (peak === 0) {
    return (
      <EmptyState
        icon="reports"
        title={content.reports.seriesEmptyHeading}
        description={content.reports.seriesEmptyBody}
      />
    );
  }

  const scale = chartScale(peak);
  const labelledDays = new Set(dayLabelIndexes(series.length));
  const activePoint = activeIndex === null ? undefined : series[activeIndex];

  function moveFocus(from: number, delta: number): void {
    const next = Math.min(series.length - 1, Math.max(0, from + delta));

    setFocusIndex(next);
    setActiveIndex(next);
    dayRefs.current[next]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLUListElement>): void {
    const moves: Record<string, number | undefined> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      // A range is read from its start, so Home and End are its first and last
      // day rather than the ends of whatever is currently scrolled into view.
      Home: -series.length,
      End: series.length,
    };
    const delta = moves[event.key];

    if (delta === undefined) {
      return;
    }

    event.preventDefault();
    moveFocus(focusIndex, delta);
  }

  return (
    <div className={styles.chart}>
      <ChartLegend />
      {/* Said before the columns rather than after them, so a screen-reader user
          is told the days are reachable before they reach the first one. */}
      <VisuallyHidden as="p">{content.reports.seriesKeyboardHint}</VisuallyHidden>

      <div className={styles.plot} ref={plotRef}>
        <ChartValueAxis
          axisLabel={content.reports.seriesValueAxisLabel}
          lines={scale.ticks.map((value) => ({
            id: String(value),
            fraction: barFraction(value, scale.max),
            label: formatCount(value, content),
          }))}
        />

        {activePoint === undefined ? null : (
          <div className={styles.readoutAnchor} ref={readoutRef}>
            <ChartDayReadout point={activePoint} />
          </div>
        )}

        <div className={styles.scroller} onScroll={positionReadout}>
          <ul
            className={styles.days}
            aria-label={content.reports.seriesHeading}
            onKeyDown={onKeyDown}
            onMouseLeave={() => {
              setActiveIndex(null);
            }}
          >
            {series.map((point, index) => (
              <li
                key={point.date}
                className={styles.day}
                data-active={indexState(index, activeIndex)}
              >
                <span
                  ref={(node) => {
                    dayRefs.current[index] = node;
                  }}
                  className={styles.dayTarget}
                  role="img"
                  aria-label={dayAccessibleLabel(point)}
                  tabIndex={index === focusIndex ? 0 : -1}
                  onFocus={() => {
                    setFocusIndex(index);
                    setActiveIndex(index);
                  }}
                  onBlur={() => {
                    setActiveIndex(null);
                  }}
                  onMouseEnter={() => {
                    setActiveIndex(index);
                  }}
                >
                  <Bar value={point.created} max={scale.max} series="created" columnIndex={index} />
                  <Bar
                    value={point.resolved}
                    max={scale.max}
                    series="resolved"
                    columnIndex={index}
                  />
                </span>
              </li>
            ))}
          </ul>

          <ul className={styles.dayAxis} aria-hidden="true">
            {series.map((point, index) => (
              <li key={point.date} className={styles.dayAxisCell}>
                {labelledDays.has(index) ? (
                  <span
                    className={styles.dayAxisLabel}
                    data-anchor={anchorFor(index, series.length)}
                  >
                    {formatReportDayLabel(point.date, content)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** `'true'` on the active column, `'false'` on the ones it dims, nothing at rest. */
function indexState(index: number, activeIndex: number | null): 'true' | 'false' | undefined {
  if (activeIndex === null) {
    return undefined;
  }

  return index === activeIndex ? 'true' : 'false';
}

/**
 * A label under the first or last column would hang off the plotting area, so
 * those two hug their edge instead of centring on their column.
 */
function anchorFor(index: number, length: number): 'start' | 'end' | undefined {
  if (index === 0) {
    return 'start';
  }

  return index === length - 1 ? 'end' : undefined;
}

/**
 * One series' bar for one day.
 *
 * A zero keeps its slot and draws a **baseline tick** rather than nothing: an
 * empty stretch across a quiet week read as missing data, which is the opposite
 * of what it means. The tick is a neutral rule, not a very short bar, so it
 * cannot be mistaken for a day with one ticket on it.
 *
 * `--bar-fill` and `--bar-column` are the two things a component may set inline:
 * both are per-instance measurements of the data, and the rules that consume
 * them live in the module file.
 */
function Bar({
  value,
  max,
  series,
  columnIndex,
}: {
  value: number;
  max: number;
  series: 'created' | 'resolved';
  columnIndex: number;
}) {
  return (
    <span
      aria-hidden="true"
      className={styles.bar}
      data-series={series}
      data-empty={value === 0 ? 'true' : undefined}
      style={
        {
          '--bar-fill': barFraction(value, max),
          // Capped, so a quarter's worth of columns does not turn a 200ms entry
          // into a second and a half of rippling.
          '--bar-column': Math.min(columnIndex, MAX_STAGGERED_COLUMNS),
        } as CSSProperties
      }
    />
  );
}
