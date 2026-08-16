import { describe, expect, it } from 'vitest';
import { REPORT_RANGE_MAX_DAYS } from '@whatsappcrm/contracts';
import { DEFAULT_RANGE_DAYS } from './constants';
import {
  defaultRange,
  isUsableRange,
  parseReportParams,
  presetRange,
  shiftDays,
  todayInUtc,
} from './report-params';

/**
 * The URL is the dashboard's state, so this module decides what every shared
 * link, refresh and back-button press renders. Two properties matter more than
 * the rest:
 *
 *   1. **It never produces a query the endpoint would refuse.** `from` after
 *      `to` and a range over a year are `validation_failed` on the wire, and
 *      neither is worth a round trip to discover.
 *   2. **It always produces a complete range**, so the picker, the metrics
 *      request and TAR-431's export URL are derived from one value rather than
 *      each deciding for itself what "no range" means.
 */

const TODAY = '2026-08-15';

function parse(raw: Partial<Record<'from' | 'to' | 'scope', string>>) {
  return parseReportParams({ from: raw.from, to: raw.to, scope: raw.scope }, TODAY);
}

describe('the applied range', () => {
  it('uses the dates in the URL when they are a usable range', () => {
    expect(parse({ from: '2026-07-01', to: '2026-07-31' })).toMatchObject({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  it('falls back to the default range when either date is missing', () => {
    const expected = defaultRange(TODAY);

    expect(parse({})).toMatchObject(expected);
    expect(parse({ from: '2026-07-01' })).toMatchObject(expected);
    expect(parse({ to: '2026-07-31' })).toMatchObject(expected);
  });

  it('falls back rather than sending a malformed date to the API', () => {
    // A hand-edited or truncated URL is the case: `2026-7-1` is not
    // `YYYY-MM-DD`, and the endpoint answers `validation_failed` for it.
    expect(parse({ from: '2026-7-1', to: '2026-07-31' })).toMatchObject(defaultRange(TODAY));
    expect(parse({ from: 'last-week', to: 'today' })).toMatchObject(defaultRange(TODAY));
  });

  it('falls back when the range runs backwards, rather than silently swapping it', () => {
    // Swapping would answer a question the supervisor did not ask, and the
    // dates in the picker would then disagree with the ones in the URL.
    expect(parse({ from: '2026-07-31', to: '2026-07-01' })).toMatchObject(defaultRange(TODAY));
  });

  it('falls back when the range is longer than the contract allows', () => {
    const from = shiftDays(TODAY, -REPORT_RANGE_MAX_DAYS);

    expect(isUsableRange(from, TODAY)).toBe(false);
    expect(parse({ from, to: TODAY })).toMatchObject(defaultRange(TODAY));
  });

  it('accepts a range of exactly the maximum, which is inclusive of both ends', () => {
    const from = shiftDays(TODAY, -(REPORT_RANGE_MAX_DAYS - 1));

    expect(isUsableRange(from, TODAY)).toBe(true);
    expect(parse({ from, to: TODAY })).toMatchObject({ from, to: TODAY });
  });

  it('accepts a single day', () => {
    expect(parse({ from: TODAY, to: TODAY })).toMatchObject({ from: TODAY, to: TODAY });
  });
});

describe('the scope', () => {
  it('defaults to the widest scope the caller may actually be given', () => {
    // `all` is narrowed rather than refused for a caller without
    // `report:read_all`, so it is the safe default rather than a hopeful one.
    expect(parse({}).scope).toBe('all');
    expect(parse({ scope: 'everything' }).scope).toBe('all');
  });

  it('keeps a scope the contract recognises', () => {
    expect(parse({ scope: 'assigned' }).scope).toBe('assigned');
  });
});

describe('range arithmetic', () => {
  it('counts a preset inclusively, so "last 7 days" is 7 days including today', () => {
    expect(presetRange(TODAY, 7)).toEqual({ from: '2026-08-09', to: TODAY });
  });

  it('defaults to a month of work', () => {
    expect(defaultRange(TODAY)).toEqual({
      from: shiftDays(TODAY, -(DEFAULT_RANGE_DAYS - 1)),
      to: TODAY,
    });
  });

  it('crosses a month boundary correctly', () => {
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('reads a calendar day off an instant without a timezone of its own', () => {
    // UTC deliberately, and the same day either side of a local midnight: these
    // are date labels, and the tenant's zone is applied by the API.
    expect(todayInUtc(new Date('2026-08-15T23:59:59.000Z'))).toBe('2026-08-15');
    expect(todayInUtc(new Date('2026-08-16T00:00:00.000Z'))).toBe('2026-08-16');
  });
});
