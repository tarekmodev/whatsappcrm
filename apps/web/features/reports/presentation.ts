import type { AgentReportRow } from '@whatsappcrm/contracts';
import type { Content } from '@/lib/content';

/**
 * How the dashboard's numbers read.
 *
 * Formatting lives here and nowhere else, and that is a contract decision rather
 * than a tidiness one: ADR 0009 decision 7 keeps the API on integer seconds
 * precisely so the console owns the only duration formatter in the system. A
 * second one — in the CSV, in a widget, in an email — is how "2h 14m" on screen
 * and "2h 15m" in a report start disagreeing.
 *
 * Everything here is a pure function of its arguments. Nothing reads the clock,
 * so server and client render the same string and there is nothing to hydrate
 * around.
 */

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;

interface DurationUnit {
  readonly unit: 'day' | 'hour' | 'minute' | 'second';
  readonly seconds: number;
}

/**
 * Largest first. Two of these are ever shown: "2h 14m" is a cycle time somebody
 * can act on, and "2h 14m 6s" is a stopwatch reading.
 */
const DURATION_UNITS: readonly DurationUnit[] = [
  { unit: 'day', seconds: SECONDS_PER_DAY },
  { unit: 'hour', seconds: SECONDS_PER_HOUR },
  { unit: 'minute', seconds: SECONDS_PER_MINUTE },
  { unit: 'second', seconds: 1 },
];

/**
 * A duration as "2h 14m", or the content layer's "No data" for a null.
 *
 * **Null is not zero**, and the contract is explicit about why: a range in which
 * nothing was answered and a range in which everything was answered instantly are
 * different facts, and rendering the first as `0s` would report a team's quiet
 * week as its best one.
 *
 * Units are phrased by `Intl`, not by a hardcoded `'h'`, so a second locale needs
 * no change here.
 */
export function formatDuration(seconds: number | null, content: Content): string {
  if (seconds === null) {
    return content.reports.noMeasurement;
  }

  const parts: string[] = [];
  let remaining = Math.max(0, Math.round(seconds));

  for (const [index, { unit, seconds: size }] of DURATION_UNITS.entries()) {
    const value = Math.floor(remaining / size);
    const isLastUnit = index === DURATION_UNITS.length - 1;

    if (value > 0 || (parts.length === 0 && isLastUnit)) {
      parts.push(formatUnit(value, unit, content.locale));
      remaining -= value * size;
    }

    // The first non-zero unit and the one below it, and no further: a second
    // part that is itself zero is noise, so "2h" stays "2h" rather than "2h 0m".
    if (parts.length === 2 || (parts.length === 1 && remaining === 0)) {
      break;
    }
  }

  return parts.join(' ');
}

function formatUnit(value: number, unit: DurationUnit['unit'], locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(
    value,
  );
}

/** Grouped by `Intl`, so a five-figure ticket count is readable. */
export function formatCount(value: number, content: Content): string {
  return new Intl.NumberFormat(content.locale).format(value);
}

/**
 * A `YYYY-MM-DD` as "17 Jul 2026".
 *
 * Formatted in **UTC** with an explicit locale, matching `RelativeTime`: these
 * are calendar labels rather than instants, and a formatter left to the runtime's
 * own zone would render the previous day for half the world.
 */
export function formatReportDate(date: string, content: Content): string {
  return new Intl.DateTimeFormat(content.locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

/** The same date without its year, for an axis where the year is already said. */
export function formatReportDayLabel(date: string, content: Content): string {
  return new Intl.DateTimeFormat(content.locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

/**
 * What a row is called: the agent's name, or the content layer's word for work
 * whose owner was never recorded.
 *
 * The unattributed row is named rather than left blank on purpose — it is the row
 * that makes the table add up to the totals above it, and an empty cell reads as
 * a rendering bug rather than as a fact about the data.
 */
export function agentRowLabel(row: AgentReportRow, content: Content): string {
  return row.name ?? content.reports.unattributed;
}
