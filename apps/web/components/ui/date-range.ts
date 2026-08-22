/**
 * The shape `DateRangeField` and its popover agree on.
 *
 * Its own module rather than an export from the component, so the panel and the
 * field can both import it without either depending on the other.
 */

export interface DateRange {
  /** The first day of the range, as a `YYYY-MM-DD`. */
  readonly from: string;
  /** The last day, inclusive. */
  readonly to: string;
}

export interface DateRangePreset {
  readonly id: string;
  /** "Last 30 days" — through the content layer, like every other label. */
  readonly label: string;
  readonly range: DateRange;
}
