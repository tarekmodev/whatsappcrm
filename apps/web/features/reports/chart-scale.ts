/**
 * The arithmetic behind the daily-volume chart's axes.
 *
 * Pure functions, in their own module, for the same reason `presentation.ts`
 * exists: an axis that is computed inside a render is an axis nobody can test,
 * and "which days get a label" is exactly the kind of rule that is quietly wrong
 * at 90 days and obviously wrong at 366.
 */

/** The value axis: a ceiling the bars are measured against, and its gridlines. */
export interface ChartScale {
  /** The top of the plotting area. Always at or above the series' peak. */
  readonly max: number;
  /** Ascending, starting at zero and ending at `max`. */
  readonly ticks: readonly number[];
}

/**
 * How many intervals the value axis aims for. Four is the number that reads as a
 * scale rather than as a grid: fewer and a bar's height is a guess, more and the
 * lines compete with the bars they are there to measure.
 */
const TARGET_INTERVALS = 4;

/**
 * The steps a person reads without arithmetic. Anything outside this set — 3, 7,
 * 35 — makes a reader do division to place a bar, which is the one job an axis
 * has.
 */
const NICE_MULTIPLES = [1, 2, 5] as const;

/**
 * A value axis for a series whose largest value is `peak`.
 *
 * The ceiling is rounded **up** to a whole number of steps, never down, so no bar
 * can be taller than the axis it is drawn against. A peak of zero is not this
 * function's problem — the chart renders its empty state instead — but it is
 * answered rather than divided by, so a caller that forgets cannot produce NaN.
 */
export function chartScale(peak: number): ChartScale {
  const step = niceStep(Math.max(peak, 1) / TARGET_INTERVALS);
  const max = Math.ceil(Math.max(peak, 1) / step) * step;
  const ticks: number[] = [];

  for (let value = 0; value <= max; value += step) {
    ticks.push(value);
  }

  return { max, ticks };
}

/**
 * The smallest of 1, 2 or 5 times a power of ten that is at least `raw`, and
 * never below one — the axis counts tickets, and there is no half a ticket.
 */
function niceStep(raw: number): number {
  if (raw <= 1) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(raw));

  for (const multiple of NICE_MULTIPLES) {
    if (raw <= multiple * magnitude) {
      return multiple * magnitude;
    }
  }

  return 10 * magnitude;
}

/**
 * How many days may carry a label before the axis is a wall of dates. Six over a
 * 320px chart is already tight; the tooltip and the screen-reader text carry the
 * per-day precision, and the axis only has to say roughly where in the range a
 * column sits.
 */
const MAX_DAY_LABELS = 6;

/**
 * Day intervals worth labelling, in the units a person actually thinks in:
 * every day, every other day, weekly, fortnightly, monthly, and up.
 */
const DAY_LABEL_STEPS = [1, 2, 7, 14, 30, 60, 90, 180] as const;

/**
 * Which days on an axis of `dayCount` days get a written date.
 *
 * Weekly over a month, monthly over a quarter — the intervals a supervisor
 * already reads a range in — rather than the two endpoints the chart used to
 * label, which said where the range started and nothing about where in it a
 * spike sat.
 */
export function dayLabelIndexes(dayCount: number): readonly number[] {
  if (dayCount <= 0) {
    return [];
  }

  const step =
    DAY_LABEL_STEPS.find((candidate) => Math.ceil(dayCount / candidate) <= MAX_DAY_LABELS) ??
    // A range longer than the widest step. It cannot happen — the contract caps
    // a range at 366 days and 180 covers that — but a fallback beats an
    // `undefined` reaching the loop below.
    DAY_LABEL_STEPS.at(-1) ??
    1;
  const indexes: number[] = [];

  for (let index = 0; index < dayCount; index += step) {
    indexes.push(index);
  }

  return indexes;
}

/**
 * A bar's height as a fraction of the plotting area, `0`–`1`.
 *
 * Against the axis ceiling rather than against the peak, so a bar's height and
 * the gridline beside it agree — measuring against the peak made the tallest bar
 * touch the top of the track whatever the axis said.
 */
export function barFraction(value: number, max: number): number {
  return max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
}
