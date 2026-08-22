import { shiftDays } from '@/lib/date/calendar-date';

/**
 * How a calendar day is written in the console — "18 Jul 2026", never the
 * browser's own `18/07/2026`.
 *
 * Every formatter here is given the content layer's locale and pinned to **UTC**:
 * these are calendar labels rather than instants, and a formatter left to the
 * runtime's own zone renders the previous day for half the world — which would
 * also make the server's markup and the browser's differ.
 */

const DAYS_PER_WEEK = 7;

/** The reference week these headings are read off; a Sunday, so index 0 is index 0. */
const REFERENCE_SUNDAY = '2026-01-04';

/** "18 Jul 2026" — the console's one date label. */
export function formatCalendarDate(date: string, locale: string): string {
  return format(date, locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The same date without its year, for an axis where the year is already said. */
export function formatCalendarDay(date: string, locale: string): string {
  return format(date, locale, { day: 'numeric', month: 'short' });
}

/**
 * "Saturday 18 July 2026" — what a day cell in a grid is called.
 *
 * Spelled out because the visible cell is a bare numeral: "18" tells a screen
 * reader nothing about which month it is in or where in the week it sits.
 */
export function formatCalendarDateLong(date: string, locale: string): string {
  return format(date, locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** "July 2026" — the heading over one month's grid. */
export function formatCalendarMonth(monthStart: string, locale: string): string {
  return format(monthStart, locale, { month: 'long', year: 'numeric' });
}

/** The day of the week a locale's calendar starts on, as a `Date.getUTCDay` index. */
export function firstWeekdayFor(locale: string): number {
  const info = weekInfoFor(locale);

  // `firstDay` is 1 (Monday) through 7 (Sunday); `getUTCDay` is 0 (Sunday)
  // through 6. Sunday is the only one that has to move.
  return info === undefined ? ISO_FIRST_WEEKDAY : info.firstDay % DAYS_PER_WEEK;
}

export interface WeekdayHeading {
  /** Two or three letters, for the column header a sighted reader scans. */
  readonly short: string;
  /** The full name, for the one a screen reader hears. */
  readonly long: string;
}

/** The seven column headings, in the order the locale's week runs. */
export function weekdayHeadings(locale: string): readonly WeekdayHeading[] {
  const first = firstWeekdayFor(locale);

  return Array.from({ length: DAYS_PER_WEEK }, (_unused, offset) => {
    const date = shiftDays(REFERENCE_SUNDAY, (first + offset) % DAYS_PER_WEEK);

    return {
      short: format(date, locale, { weekday: 'short' }),
      long: format(date, locale, { weekday: 'long' }),
    };
  });
}

function format(date: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00.000Z`),
  );
}

/**
 * Monday, when the runtime cannot say. ISO 8601's own answer rather than a
 * guess, and it is only reached on a runtime whose ICU predates `weekInfo`.
 */
const ISO_FIRST_WEEKDAY = 1;

interface WeekInfo {
  readonly firstDay: number;
}

/**
 * `Intl.Locale`'s week metadata, which shipped as a `weekInfo` getter and is
 * being restandardised as `getWeekInfo()`. TypeScript's lib declares neither, so
 * both are read through a narrow rather than asserted onto the type.
 */
function weekInfoFor(locale: string): WeekInfo | undefined {
  const candidate: unknown = new Intl.Locale(locale);

  if (typeof candidate !== 'object' || candidate === null) {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  const info =
    typeof record.getWeekInfo === 'function'
      ? (record.getWeekInfo as () => unknown).call(candidate)
      : record.weekInfo;

  if (typeof info !== 'object' || info === null) {
    return undefined;
  }

  const firstDay = (info as Record<string, unknown>).firstDay;

  return typeof firstDay === 'number' ? { firstDay } : undefined;
}
