import { describe, expect, it } from 'vitest';
import {
  DashboardExportQuerySchema,
  DashboardMetricsQuerySchema,
  DurationStatsSchema,
  REPORT_RANGE_MAX_DAYS,
  reportRangeDays,
} from './reporting';

/**
 * The reporting contract ADR 0010 publishes, pinned where getting it wrong is
 * silent — a range that slips past the cap, a duration that reads as zero, or a
 * query parse that differs between the two routes decision 1 exists to keep
 * identical.
 */

const RANGE = { from: '2026-08-01', to: '2026-08-07' };

describe('reportRangeDays', () => {
  it('counts both endpoints', () => {
    expect(reportRangeDays('2026-08-01', '2026-08-01')).toBe(1);
    expect(reportRangeDays('2026-08-01', '2026-08-07')).toBe(7);
  });

  it('counts calendar days across a DST boundary', () => {
    // Parsed as UTC on both sides deliberately: this counts days, it does not
    // resolve them. A zone-aware subtraction would return 30.958… here and
    // round the cap off by one somewhere in Europe every March.
    expect(reportRangeDays('2026-03-01', '2026-03-31')).toBe(31);
  });
});

describe('DashboardMetricsQuerySchema', () => {
  it('defaults scope to the widest the caller may have', () => {
    // `all` is the request; what they actually get is narrowed server-side by
    // `report:read_all`, never by this default.
    expect(DashboardMetricsQuerySchema.parse(RANGE).scope).toBe('all');
  });

  it('refuses a reversed range', () => {
    expect(
      DashboardMetricsQuerySchema.safeParse({ from: '2026-08-07', to: '2026-08-01' }).success,
    ).toBe(false);
  });

  it('accepts a range of exactly the cap and refuses one day more', () => {
    // The bound is inclusive, and a year plus a leap day has to go through.
    expect(
      DashboardMetricsQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success,
    ).toBe(true);
    expect(reportRangeDays('2026-01-01', '2026-12-31')).toBe(365);

    expect(
      DashboardMetricsQuerySchema.safeParse({ from: '2026-01-01', to: '2027-01-02' }).success,
    ).toBe(false);
    expect(reportRangeDays('2026-01-01', '2027-01-02')).toBe(REPORT_RANGE_MAX_DAYS + 1);
  });

  it('refuses an instant where a tenant-local date belongs', () => {
    // 0010 decision 5: the client never sends the zone, so it never sends an
    // instant either.
    expect(
      DashboardMetricsQuerySchema.safeParse({ ...RANGE, from: '2026-08-01T00:00:00Z' }).success,
    ).toBe(false);
  });
});

describe('DashboardExportQuerySchema', () => {
  it('parses the dashboard parameters identically', () => {
    // The property 0010 decision 1 turns on: both routes are built from one
    // shape, so "the range the export used" and "the range the screen shows"
    // are the same parsed value. A drift here is the parity criterion failing
    // before a single row is read.
    const query = { ...RANGE, scope: 'assigned' as const };

    const exported = DashboardExportQuerySchema.parse(query);
    const shown = DashboardMetricsQuerySchema.parse(query);

    // `section` is the export's own field and the only thing that may differ;
    // compared key by key rather than by destructuring it away, so a field added
    // to one schema and not the other fails here instead of vanishing.
    expect(Object.keys(exported).sort()).toEqual([...Object.keys(shown), 'section'].sort());
    for (const key of Object.keys(shown) as (keyof typeof shown)[]) {
      expect(exported[key]).toEqual(shown[key]);
    }
  });

  it('applies the same range rules', () => {
    expect(
      DashboardExportQuerySchema.safeParse({ from: '2026-01-01', to: '2027-01-02' }).success,
    ).toBe(false);
  });

  it('defaults to the section a supervisor downloads', () => {
    expect(DashboardExportQuerySchema.parse(RANGE).section).toBe('agents');
  });

  it('refuses an unknown section', () => {
    expect(DashboardExportQuerySchema.safeParse({ ...RANGE, section: 'everything' }).success).toBe(
      false,
    );
  });
});

describe('DurationStatsSchema', () => {
  it('requires null durations exactly when nothing was counted', () => {
    // "No ticket was answered" and "every ticket was answered instantly" are
    // different facts, and a zero renders as the second.
    expect(
      DurationStatsSchema.safeParse({
        count: 0,
        averageSeconds: null,
        medianSeconds: null,
        p90Seconds: null,
      }).success,
    ).toBe(true);

    expect(
      DurationStatsSchema.safeParse({
        count: 0,
        averageSeconds: 0,
        medianSeconds: 0,
        p90Seconds: 0,
      }).success,
    ).toBe(false);

    expect(
      DurationStatsSchema.safeParse({
        count: 3,
        averageSeconds: 120,
        medianSeconds: null,
        p90Seconds: 300,
      }).success,
    ).toBe(false);
  });
});
