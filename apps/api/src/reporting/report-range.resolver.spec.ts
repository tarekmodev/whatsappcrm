import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ReportRangeResolver } from './report-range.resolver';

/**
 * The range resolution ADR 0010 decision 5 fixes: two tenant-local calendar
 * dates in, one half-open instant interval out, with the zone read server-side.
 *
 * What is asserted here is the *shape* of that conversion — that the dates are
 * bound rather than interpolated, that the interval is half-open, and that a
 * tenant with no settings row still gets a report. The arithmetic itself is
 * Postgres's, deliberately (one engine, one tz database, one set of DST rules),
 * so `reporting-metrics.int-spec.ts` is where a boundary is proved against a
 * real zone.
 */

const RIYADH_ROW = {
  timezone: 'Asia/Riyadh',
  // 2026-08-01 00:00 and 2026-08-08 00:00 in +03:00.
  starts_at: new Date('2026-07-31T21:00:00.000Z'),
  ends_at: new Date('2026-08-07T21:00:00.000Z'),
  fell_back: false,
};

function build(rows: unknown[]) {
  const queryRaw = jest.fn().mockResolvedValue(rows);

  return {
    queryRaw,
    resolver: new ReportRangeResolver(),
    /** The statement as Prisma flattens it, so nested fragments are visible. */
    statement: (): Prisma.Sql => {
      const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];

      return new Prisma.Sql(strings, values);
    },
  };
}

describe('ReportRangeResolver', () => {
  const QUERY = { from: '2026-08-01', to: '2026-08-07' };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the resolved interval as instants and echoes the range as dates', async () => {
    const { resolver, queryRaw } = build([RIYADH_ROW]);

    const resolved = await resolver.resolve({ $queryRaw: queryRaw } as never, QUERY);

    expect(resolved.range).toEqual({
      from: '2026-08-01',
      to: '2026-08-07',
      timezone: 'Asia/Riyadh',
      startsAt: '2026-07-31T21:00:00.000Z',
      endsAt: '2026-08-07T21:00:00.000Z',
    });
    // The `Date`s the statements compare against, not re-parsed from the strings
    // above: one conversion, in Postgres, and everything downstream uses its
    // result.
    expect(resolved.startsAt).toBe(RIYADH_ROW.starts_at);
    expect(resolved.endsAt).toBe(RIYADH_ROW.ends_at);
  });

  it('asks for a half-open interval — `to` plus one day, exclusive', async () => {
    // The property that makes "23:30 local on the last day is inside the range"
    // true without an end-of-day literal anybody has to remember to write.
    const { resolver, queryRaw, statement } = build([RIYADH_ROW]);

    await resolver.resolve({ $queryRaw: queryRaw } as never, QUERY);

    expect(statement().sql).toContain('::date + 1');
  });

  it('binds both dates rather than interpolating them', async () => {
    const { resolver, queryRaw, statement } = build([RIYADH_ROW]);

    await resolver.resolve({ $queryRaw: queryRaw } as never, QUERY);

    const sent = statement();

    expect(sent.values).toEqual(['2026-08-01', '2026-08-07']);
    expect(sent.sql).not.toContain('2026-08-01');
  });

  it('falls back to UTC and says so when the tenant has no settings row', async () => {
    // A provisioning gap rather than a caller error: the tenant gets a valid
    // report whose day boundaries are UTC's, and `range.timezone` echoes what
    // was actually used so the console is not guessing.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { resolver, queryRaw } = build([
      {
        timezone: 'UTC',
        starts_at: new Date('2026-08-01T00:00:00.000Z'),
        ends_at: new Date('2026-08-08T00:00:00.000Z'),
        fell_back: true,
      },
    ]);

    const resolved = await resolver.resolve({ $queryRaw: queryRaw } as never, QUERY);

    expect(resolved.range.timezone).toBe('UTC');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn for a tenant that has a zone', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { resolver, queryRaw } = build([RIYADH_ROW]);

    await resolver.resolve({ $queryRaw: queryRaw } as never, QUERY);

    expect(warn).not.toHaveBeenCalled();
  });

  it('fails loudly rather than defaulting when the statement returns nothing', async () => {
    // Unreachable — the CTE aggregates, so it answers one row whatever the table
    // holds. Reported as the fault it would be: a report over a range nobody
    // chose is worse than an error.
    const { resolver, queryRaw } = build([]);

    await expect(resolver.resolve({ $queryRaw: queryRaw } as never, QUERY)).rejects.toThrow(
      'The report range query returned no row.',
    );
  });
});
