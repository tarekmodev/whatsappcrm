'use client';

import { useEffect, useState } from 'react';
import styles from './RelativeTime.module.css';

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
 */
export function RelativeTime({
  isoTimestamp,
  label,
}: {
  /** ISO 8601 with offset, exactly as the contract transports timestamps. */
  isoTimestamp: string;
  /** Accessible prefix, so the figure is not a bare number to a screen reader. */
  label: string;
}) {
  const [relative, setRelative] = useState<string | null>(null);

  useEffect(() => {
    setRelative(formatRelative(isoTimestamp));
  }, [isoTimestamp]);

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

  return formatter.format(-Math.round(elapsedSeconds / SECONDS_PER_DAY), 'day');
}
