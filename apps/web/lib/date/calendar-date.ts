/**
 * Calendar arithmetic on a `YYYY-MM-DD`, in UTC.
 *
 * UTC deliberately, and everywhere: these are date *labels*, not instants.
 * Adding a day to a local-time value crosses a DST boundary twice a year and
 * lands back on the date it started from, and a grid built that way silently
 * repeats or skips a day for half the world.
 *
 * Nothing here reads the clock. Every function is total on its inputs, so the
 * same call renders the same markup on the server and in the browser.
 */

const CALENDAR_DATE_LENGTH = 'YYYY-MM-DD'.length;
const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;

/** `YYYY-MM-DD`, digits only — a shape check before the round-trip below. */
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a string names a real calendar day.
 *
 * The round-trip is what rejects `2026-02-30`: `Date.parse` accepts it and rolls
 * it forward to March, so the only way to tell a typo from a date is to format
 * the parsed value back and see whether it still says what it was given.
 */
export function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) {
    return false;
  }

  const parsed = Date.parse(`${value}T00:00:00.000Z`);

  return !Number.isNaN(parsed) && toCalendarDate(new Date(parsed)) === value;
}

export function toCalendarDate(date: Date): string {
  return date.toISOString().slice(0, CALENDAR_DATE_LENGTH);
}

export function shiftDays(date: string, days: number): string {
  return toCalendarDate(new Date(Date.parse(`${date}T00:00:00.000Z`) + days * MS_PER_DAY));
}

/** The first of the month a date falls in, as a `YYYY-MM-DD`. */
export function startOfMonth(date: string): string {
  return `${date.slice(0, 'YYYY-MM'.length)}-01`;
}

/**
 * The same day-of-month `months` away, clamped to the target month's length —
 * so a step back from 31 March lands on 28 February rather than on 3 March.
 */
export function addMonths(date: string, months: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const target = new Date(parsed);

  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  target.setUTCDate(Math.min(parsed.getUTCDate(), daysInMonth(target)));

  return toCalendarDate(target);
}

export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 'YYYY-MM'.length) === b.slice(0, 'YYYY-MM'.length);
}

/** `0` for Sunday through `6` for Saturday, matching `Date.getUTCDay`. */
export function weekdayIndex(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

export interface CalendarWeek {
  /** The week's first day, which is also a stable React key for the row. */
  readonly start: string;
  readonly days: readonly string[];
}

/**
 * A month laid out as whole weeks, each padded from the months either side, so
 * a grid renders as a rectangle without the caller counting blanks.
 *
 * `firstWeekday` is the locale's, not a constant: a week starts on Sunday, on
 * Monday or on Saturday depending on where the reader is, and a grid that
 * assumes one of them is wrong in most of the world.
 */
export function monthWeeks(monthStart: string, firstWeekday: number): readonly CalendarWeek[] {
  const leading = (weekdayIndex(monthStart) - firstWeekday + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  const total = daysInMonth(new Date(`${monthStart}T00:00:00.000Z`));
  const weekCount = Math.ceil((leading + total) / DAYS_PER_WEEK);

  return Array.from({ length: weekCount }, (_unused, week) => {
    const days = Array.from({ length: DAYS_PER_WEEK }, (_ignored, offset) =>
      shiftDays(monthStart, week * DAYS_PER_WEEK + offset - leading),
    );

    return { start: shiftDays(monthStart, week * DAYS_PER_WEEK - leading), days };
  });
}

/** Keeps a date inside an optional floor and ceiling, both inclusive. */
export function clampDate(date: string, min: string | undefined, max: string | undefined): string {
  if (min !== undefined && date < min) {
    return min;
  }

  if (max !== undefined && date > max) {
    return max;
  }

  return date;
}

function daysInMonth(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}
