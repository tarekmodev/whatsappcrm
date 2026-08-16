import {
  DashboardMetricsResponseSchema,
  type DashboardMetricsResponse,
} from '@whatsappcrm/contracts';
import { serialiseDashboardCsv } from './dashboard-csv.serialiser';

/**
 * The bytes of the export, asserted as bytes.
 *
 * Every property here is one a spreadsheet, not a test, is the real consumer
 * of — a missing BOM, an unquoted comma or a live formula are all invisible in
 * a passing JSON test and obvious the moment a supervisor opens the file. So
 * the expectations below are literal strings rather than a re-serialisation.
 *
 * The fixture is parsed through `DashboardMetricsResponseSchema` before it is
 * used, so a fixture that could not come out of the real query layer fails here
 * rather than proving something about a shape the API cannot produce.
 */

const SUPERVISOR_ID = '9c0c1f60-3a41-7a2e-8f0e-0b3d5a1c0001';
const CONTRACTOR_ID = '9c0c1f60-3a41-7a2e-8f0e-0b3d5a1c0002';

/** No ticket was answered: the durations are null, and null is not zero. */
const NOTHING = { count: 0, averageSeconds: null, medianSeconds: null, p90Seconds: null };

const METRICS: DashboardMetricsResponse = DashboardMetricsResponseSchema.parse({
  range: {
    from: '2026-08-01',
    to: '2026-08-03',
    timezone: 'Asia/Riyadh',
    startsAt: '2026-07-31T21:00:00.000Z',
    endsAt: '2026-08-03T21:00:00.000Z',
  },
  scope: 'all',
  summary: {
    volume: { created: 12, resolved: 9, closedWithoutResolution: 2 },
    firstResponse: { count: 9, averageSeconds: 400, medianSeconds: 300, p90Seconds: 900 },
    resolution: { count: 9, averageSeconds: 8040, medianSeconds: 7200, p90Seconds: 18_000 },
  },
  agents: [
    {
      userId: SUPERVISOR_ID,
      // A comma inside a name, and Arabic. Both are ordinary in this product.
      name: 'ليلى, المشرفة',
      isActive: true,
      ticketsResolved: 5,
      firstResponse: { count: 5, averageSeconds: 360, medianSeconds: 300, p90Seconds: 720 },
      resolution: { count: 5, averageSeconds: 7000, medianSeconds: 6800, p90Seconds: 15_000 },
    },
    {
      userId: CONTRACTOR_ID,
      name: "=cmd|' /c calc'!A1",
      isActive: false,
      ticketsResolved: 4,
      firstResponse: { count: 4, averageSeconds: 450, medianSeconds: 300, p90Seconds: 900 },
      resolution: { count: 4, averageSeconds: 9300, medianSeconds: 7800, p90Seconds: 18_000 },
    },
    // The unattributed row: work whose responder or resolver was never recorded.
    {
      userId: null,
      name: null,
      isActive: false,
      ticketsResolved: 0,
      firstResponse: NOTHING,
      resolution: NOTHING,
    },
  ],
  series: [
    { date: '2026-08-01', created: 5, resolved: 4, firstResponseMedianSeconds: 280 },
    { date: '2026-08-02', created: 0, resolved: 0, firstResponseMedianSeconds: null },
    { date: '2026-08-03', created: 7, resolved: 5, firstResponseMedianSeconds: 320 },
  ],
});

/** The three bytes `serialiseDashboardCsv` opens every file with. */
const BYTE_ORDER_MARK = '\uFEFF';

function linesOf(section: 'summary' | 'agents' | 'series'): string[] {
  const csv = serialiseDashboardCsv(METRICS, section).toString('utf8');

  // The BOM is asserted separately, in bytes. Stripping it here keeps the row
  // expectations readable rather than prefixing the first one with an escape.
  return csv.replace(BYTE_ORDER_MARK, '').split('\r\n');
}

describe('the dashboard CSV', () => {
  describe('the bytes every section shares', () => {
    /**
     * Excel on Windows reads a BOM-less UTF-8 CSV as the local code page, and
     * the agent name two rows down is Arabic. Without these three bytes the
     * file opens as mojibake and gets reported as a data bug.
     */
    it('opens with a UTF-8 byte-order mark', () => {
      const csv = serialiseDashboardCsv(METRICS, 'summary');

      expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    });

    it('separates rows with CRLF and ends with one, per RFC 4180', () => {
      const csv = serialiseDashboardCsv(METRICS, 'series').toString('utf8');

      expect(csv.endsWith('\r\n')).toBe(true);
      expect(csv).not.toMatch(/[^\r]\n/);
    });

    it('writes the name of an agent whose display name is Arabic', () => {
      expect(linesOf('agents')[1]).toContain('ليلى');
    });
  });

  describe('the summary section', () => {
    it('carries the range, the scope and all three metric groups on one row', () => {
      expect(linesOf('summary')).toEqual([
        'from,to,timezone,scope,tickets_created,tickets_resolved,tickets_closed_without_resolution,' +
          'first_response_count,first_response_average_seconds,first_response_median_seconds,first_response_p90_seconds,' +
          'resolution_count,resolution_average_seconds,resolution_median_seconds,resolution_p90_seconds',
        '2026-08-01,2026-08-03,Asia/Riyadh,all,12,9,2,9,400,300,900,9,8040,7200,18000',
        '',
      ]);
    });
  });

  describe('the agents section', () => {
    it('writes one row per agent and ends with the summary in the same columns', () => {
      expect(linesOf('agents')).toEqual([
        'row,user_id,name,is_active,tickets_resolved,' +
          'first_response_count,first_response_average_seconds,first_response_median_seconds,first_response_p90_seconds,' +
          'resolution_count,resolution_average_seconds,resolution_median_seconds,resolution_p90_seconds',
        `agent,${SUPERVISOR_ID},"ليلى, المشرفة",true,5,5,360,300,720,5,7000,6800,15000`,
        `agent,${CONTRACTOR_ID},'=cmd|' /c calc'!A1,false,4,4,450,300,900,4,9300,7800,18000`,
        'unattributed,,,false,0,0,,,,0,,,',
        'total,,,,9,9,400,300,900,9,8040,7200,18000',
        '',
      ]);
    });

    /**
     * A name is tenant-supplied text and a CSV is opened in a spreadsheet by
     * definition. The leading quote is what every spreadsheet reads as "the
     * rest of this cell is literal" — the name stays readable and stops being
     * executable.
     */
    it('neutralises a name that a spreadsheet would run as a formula', () => {
      const contractor = linesOf('agents')[2];

      expect(contractor).toContain(`,'=cmd|`);
      expect(contractor).not.toContain(',=cmd|');
    });

    /**
     * The distinction `DurationStatsSchema` exists to preserve. `0` here would
     * say every ticket was answered instantly; the empty cell says none was,
     * and is what a spreadsheet leaves out of an average.
     */
    it('leaves a duration empty rather than zero when nothing was measured', () => {
      expect(linesOf('agents')[3]).toBe('unattributed,,,false,0,0,,,,0,,,');
    });

    /**
     * The total is the summary, never a re-derivation of the column above it.
     * Its median is not the median of the per-agent medians — a median does not
     * compose — so summing or averaging the column here would produce a number
     * the dashboard never shows.
     */
    it('takes the total row from the summary rather than from the rows above it', () => {
      const total = linesOf('agents').at(-2);

      expect(total).toBe('total,,,,9,9,400,300,900,9,8040,7200,18000');
    });
  });

  describe('the series section', () => {
    it('writes every day in the range, including the ones with nothing in them', () => {
      expect(linesOf('series')).toEqual([
        'date,created,resolved,first_response_median_seconds',
        '2026-08-01,5,4,280',
        '2026-08-02,0,0,',
        '2026-08-03,7,5,320',
        '',
      ]);
    });
  });
});
