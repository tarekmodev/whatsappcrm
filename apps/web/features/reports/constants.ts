/**
 * Numbers the dashboard is built from, named once. Each is either a contract
 * value re-exported or a presentation decision with a reason.
 */

/**
 * The range an unparameterised arrival lands on, in days including today.
 *
 * Thirty rather than seven: the four metrics are cycle times, and a week is
 * short enough that a team resolving a handful of tickets shows a median built
 * from two or three of them. It is also the range a supervisor reporting to a
 * client is most often asked for.
 */
export const DEFAULT_RANGE_DAYS = 30;

/** The quick ranges offered above the date fields, longest last. */
export const RANGE_PRESET_DAYS = [7, 30, 90] as const;
export type RangePresetDays = (typeof RANGE_PRESET_DAYS)[number];

/**
 * The narrowest a metric card may get before the overview drops a column.
 *
 * Measured rather than guessed: at the console's widest layout the grid has
 * 1086px and a 12px gap, so five cards need 200px each to share one row. A
 * wider minimum leaves the fifth card alone on a second row with three columns
 * of white space beside it, which reads as a missing card rather than as a
 * layout. Below roughly 1300px the grid drops to three columns and then to one,
 * which is `auto-fit` doing its job and needs no breakpoint.
 */
export const METRIC_CARD_MIN_WIDTH = '12.5rem';

/**
 * Rows the per-agent skeleton draws.
 *
 * Four, matching the tenant's active membership rather than a page size: the
 * table is not paginated — it is one row per agent plus the unattributed row —
 * so the honest placeholder is "about as many rows as a team has people".
 */
export const AGENT_ROWS_SKELETON_COUNT = 4;

/** Bars the daily-volume skeleton draws, matching the default range's length. */
export const SERIES_SKELETON_BARS = DEFAULT_RANGE_DAYS;

/**
 * How many of a chart's columns take a staggered entry before the rest come in
 * together.
 *
 * Twenty at `--duration-stagger` is about a quarter of a second of ripple, which
 * reads as the chart drawing itself. Uncapped, a ninety-day range would take a
 * second and a half to finish arriving, and a reader would be watching an
 * animation rather than a report.
 */
export const MAX_STAGGERED_COLUMNS = 20;

/**
 * Gridlines the daily-volume skeleton draws, evenly spaced.
 *
 * The real axis picks between three and five from the data (`chart-scale.ts`).
 * Five is the placeholder because a gridline is a hairline: being one line out
 * costs nothing in layout, and drawing the fuller grid keeps the plotting area
 * looking like a chart rather than like an empty box.
 */
export const SERIES_SKELETON_GRIDLINES = 5;
