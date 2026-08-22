'use client';

import { useEffect, useState } from 'react';
import styles from './RelativeTime.module.css';

/**
 * How far out a relative phrase stays useful. A month is where "in 29 days"
 * stops being something a reader can picture and a date starts being the shorter
 * answer; it is also comfortably past every real deadline this product sets.
 */
export const RELATIVE_TIME_MAX_DAYS = 30;

/**
 * A timestamp rendered as "3 hours ago". Usage:
 * `<RelativeTime isoTimestamp={conversation.lastMessageAt} label="Last activity" />`.
 *
 * The server renders the absolute, locale-stable value and the client upgrades it
 * to a relative one after mount. Computing "now" during render would make server
 * and client HTML differ and produce a hydration mismatch — the fix is to defer,
 * not to suppress the warning.
 *
 * `Intl.RelativeTimeFormat` does the phrasing, so no locale is hand-rolled.
 *
 * **Relative phrasing has an upper bound.** Past
 * `RELATIVE_TIME_MAX_DAYS` the component falls back to the absolute date, because
 * "in 26,430 days" is arithmetic rather than an answer — a reader converts it
 * back into a year before it means anything. The ticket queue is where that
 * showed up (TAR-520): an SLA deadline far enough out to be a sentinel rendered
 * as a five-figure day count. The rule lives here rather than at that call site
 * so every surface in the console inherits it.
 */
export function RelativeTime({
  isoTimestamp,
  label,
  refreshMs,
}: {
  /** ISO 8601 with offset, exactly as the contract transports timestamps. */
  isoTimestamp: string;
  /** Accessible prefix, so the figure is not a bare number to a screen reader. */
  label: string;
  /**
   * Re-phrase on this interval while mounted. Omitted, the value is computed
   * once after mount and left alone — right for a sent-at stamp, which only
   * drifts while somebody stares at it.
   *
   * Set it where the passage of time is the point rather than a detail: the
   * composer's service-window countdown is a deadline an agent is working
   * against, and one that silently said "in 20 minutes" for an hour would be
   * worse than no countdown at all.
   */
  refreshMs?: number;
}) {
  const [relative, setRelative] = useState<string | null>(null);

  useEffect(() => {
    setRelative(formatRelative(isoTimestamp));

    if (refreshMs === undefined) {
      return;
    }

    const timer = setInterval(() => {
      setRelative(formatRelative(isoTimestamp));
    }, refreshMs);

    return () => {
      clearInterval(timer);
    };
  }, [isoTimestamp, refreshMs]);

  return (
    <time className={styles.time} dateTime={isoTimestamp} title={`${label}: ${isoTimestamp}`}>
      {relative ?? formatAbsolute(isoTimestamp)}
    </time>
  );
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;

/**
 * Server-safe: an ISO string formatted with an explicit UTC zone, so it cannot
 * differ between the server's locale and the browser's.
 */
function formatAbsolute(isoTimestamp: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(isoTimestamp));
}

/**
 * The far-future/far-past fallback, in the reader's own locale and timezone.
 *
 * Safe to be locale-dependent where `formatAbsolute` is not: this one is only
 * ever reached from `formatRelative`, which runs after mount. The time of day is
 * dropped — at more than a month out the date is the whole of the answer.
 */
function formatAbsoluteDate(isoTimestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(isoTimestamp));
}

/**
 * Picks the unit from the *distance* to now, not the signed difference, so a
 * future timestamp — an invitation's expiry, say — reads "in 6 days" rather than
 * "in 619,918 seconds". `Intl.RelativeTimeFormat` already handles the direction
 * from the sign; only the unit choice has to be symmetric.
 */
function formatRelative(isoTimestamp: string): string {
  const elapsedSeconds = (Date.now() - new Date(isoTimestamp).getTime()) / MS_PER_SECOND;
  const distanceSeconds = Math.abs(elapsedSeconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (distanceSeconds < SECONDS_PER_MINUTE) {
    return formatter.format(-Math.round(elapsedSeconds), 'second');
  }

  if (distanceSeconds < SECONDS_PER_HOUR) {
    return formatter.format(-Math.round(elapsedSeconds / SECONDS_PER_MINUTE), 'minute');
  }

  if (distanceSeconds < SECONDS_PER_DAY) {
    return formatter.format(-Math.round(elapsedSeconds / SECONDS_PER_HOUR), 'hour');
  }

  // Beyond the bound the count stops being readable — see RELATIVE_TIME_MAX_DAYS.
  if (distanceSeconds > SECONDS_PER_DAY * RELATIVE_TIME_MAX_DAYS) {
    return formatAbsoluteDate(isoTimestamp);
  }

  return formatter.format(-Math.round(elapsedSeconds / SECONDS_PER_DAY), 'day');
}
