import { describe, expect, it } from 'vitest';
import { content } from '@/content/en';
import { formatCount, formatDuration, formatReportDate } from './presentation';

/**
 * The console owns the only duration formatter in the system — ADR 0009 keeps the
 * API on integer seconds precisely so there is nowhere else for one to appear.
 * These assertions are what stops it drifting.
 *
 * The distinction the whole file exists for: **null is not zero.** "No ticket was
 * answered" and "every ticket was answered instantly" are different facts, and
 * rendering the first as `0s` would report a team's quiet week as its best one.
 */

describe('formatDuration', () => {
  it('renders nothing measured as words, never as a zero', () => {
    expect(formatDuration(null, content)).toBe(content.reports.noMeasurement);
    expect(formatDuration(0, content)).not.toBe(content.reports.noMeasurement);
  });

  it('shows two units at most, largest first', () => {
    // 2h 14m — the ADR's own example, and the reason the CSV carries 8040.
    expect(formatDuration(8040, content)).toBe('2h 14m');
  });

  it('drops a second unit that would be zero', () => {
    expect(formatDuration(7200, content)).toBe('2h');
  });

  it('never rounds a cycle time up to a unit it did not reach', () => {
    expect(formatDuration(59, content)).toBe('59s');
    expect(formatDuration(60, content)).toBe('1m');
  });

  it('reads a multi-day resolution in days and hours rather than in hours', () => {
    // 4d 6h — a realistic resolution time, and unreadable as "102h".
    expect(formatDuration(367_200, content)).toBe('4d 6h');
  });

  it('renders an instant answer as zero seconds, which is a measurement', () => {
    expect(formatDuration(0, content)).toBe('0s');
  });
});

describe('formatCount', () => {
  it('groups a large count so it can be read at a glance', () => {
    expect(formatCount(12_345, content)).toBe('12,345');
  });
});

describe('formatReportDate', () => {
  it('formats a calendar day in UTC, so it is the same day everywhere', () => {
    // A date label, not an instant: rendering it in the runtime's own zone would
    // show the previous day for half the world.
    expect(formatReportDate('2026-08-15', content)).toBe('15 Aug 2026');
  });
});
