import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DashboardMetricsResponseSchema,
  type DashboardMetricsResponse,
  type TenantRole,
} from '@whatsappcrm/contracts';

/**
 * The export's one load-bearing property: **the file says what the screen says**
 * (TAR-30's second acceptance criterion, TAR-431 from the console's side).
 *
 * Asserted by fetching both representations of the same range and comparing
 * values, never by eyeballing a fixture — which is TAR-430's own criterion,
 * applied here to the layer that can be run today. The mock export route and the
 * mock metrics route share one aggregation, so a failure in these cases means
 * somebody has introduced a second one.
 *
 * `server-only` throws outside a React Server Component and `next/headers` needs
 * a request scope; both are stubbed the way `handlers.test.ts` stubs them, so
 * these stay plain unit tests.
 */

vi.mock('server-only', () => ({}));

let currentRole: TenantRole = 'supervisor';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'wac_role_stub' ? { name, value: currentRole } : undefined),
    }),
}));

const { handleMockRequest } = await import('./handlers');
const { resetMockState } = await import('./store');

/** Wide enough to cover every fixture ticket, so a missing one is a real absence. */
const RANGE = { from: '2026-07-01', to: '2026-08-31' };

/** An empty one, for the case where every duration is null rather than zero. */
const EMPTY_RANGE = { from: '2020-01-01', to: '2020-01-07' };

const BOM = '﻿';

async function dashboard(query: Record<string, string> = {}): Promise<DashboardMetricsResponse> {
  const params = new URLSearchParams({ ...RANGE, ...query });
  const response = await handleMockRequest({
    method: 'GET',
    path: `/v1/reports/dashboard?${params.toString()}`,
  });

  return DashboardMetricsResponseSchema.parse(response);
}

async function exported(query: Record<string, string> = {}): Promise<string> {
  const params = new URLSearchParams({ ...RANGE, ...query });
  const response = await handleMockRequest({
    method: 'GET',
    path: `/v1/reports/dashboard/export?${params.toString()}`,
  });

  return String(response);
}

/**
 * RFC 4180 in reverse. Written out rather than split on commas, because a quoted
 * agent name containing one is exactly the case a naive split would pass while
 * the file a spreadsheet opens is wrong.
 */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [[]];
  let field = '';
  let isQuoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];

    if (isQuoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        isQuoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      isQuoted = true;
    } else if (character === ',') {
      rows.at(-1)?.push(field);
      field = '';
    } else if (character === '\r' && csv[index + 1] === '\n') {
      rows.at(-1)?.push(field);
      field = '';
      rows.push([]);
      index += 1;
    } else {
      field += character;
    }
  }

  rows.at(-1)?.push(field);

  return rows.map((row, index) => (index === 0 ? row.map(stripBom) : row));
}

function stripBom(value: string): string {
  return value.startsWith(BOM) ? value.slice(BOM.length) : value;
}

function rowFor(rows: string[][], label: string): string[] {
  const row = rows.find((fields) => fields[0] === label);

  expect(row, `no row for ${label}`).toBeDefined();

  return row ?? [];
}

function column(rows: string[][], name: string): number {
  const index = rows[0]?.indexOf(name) ?? -1;

  expect(index, `no column ${name}`).toBeGreaterThanOrEqual(0);

  return index;
}

beforeEach(() => {
  resetMockState();
  currentRole = 'supervisor';
});

describe('the exported CSV', () => {
  it('carries the same figures the dashboard shows for the same range', async () => {
    const metrics = await dashboard();
    const rows = parseCsv(await exported({ section: 'agents' }));

    const total = rowFor(rows, 'TOTAL');

    expect(total[column(rows, 'tickets_resolved')]).toBe(String(metrics.summary.volume.resolved));
    expect(total[column(rows, 'first_response_median_seconds')]).toBe(
      String(metrics.summary.firstResponse.medianSeconds),
    );
    expect(total[column(rows, 'resolution_median_seconds')]).toBe(
      String(metrics.summary.resolution.medianSeconds),
    );

    // Every agent row, not only the total: a breakdown that disagrees with the
    // screen is the same failure one line further down.
    for (const agent of metrics.agents) {
      const row = rowFor(rows, agent.name ?? 'Not recorded');

      expect(row[column(rows, 'tickets_resolved')]).toBe(String(agent.ticketsResolved));
      expect(row[column(rows, 'first_response_median_seconds')]).toBe(
        agent.firstResponse.medianSeconds === null ? '' : String(agent.firstResponse.medianSeconds),
      );
    }
  });

  it('exports the range it was asked for, not the one asked for last', async () => {
    const narrow = { from: '2026-08-01', to: '2026-08-07' };
    const metrics = DashboardMetricsResponseSchema.parse(
      await handleMockRequest({
        method: 'GET',
        path: `/v1/reports/dashboard?${new URLSearchParams(narrow).toString()}`,
      }),
    );
    const rows = parseCsv(
      String(
        await handleMockRequest({
          method: 'GET',
          path: `/v1/reports/dashboard/export?${new URLSearchParams({ ...narrow, section: 'summary' }).toString()}`,
        }),
      ),
    );

    expect(rows[1]?.[column(rows, 'from')]).toBe(narrow.from);
    expect(rows[1]?.[column(rows, 'to')]).toBe(narrow.to);
    expect(rows[1]?.[column(rows, 'tickets_created')]).toBe(String(metrics.summary.volume.created));
  });

  it('writes an empty cell where nothing was measured, never a zero', async () => {
    const metrics = DashboardMetricsResponseSchema.parse(
      await handleMockRequest({
        method: 'GET',
        path: `/v1/reports/dashboard?${new URLSearchParams(EMPTY_RANGE).toString()}`,
      }),
    );
    const rows = parseCsv(
      String(
        await handleMockRequest({
          method: 'GET',
          path: `/v1/reports/dashboard/export?${new URLSearchParams({ ...EMPTY_RANGE, section: 'summary' }).toString()}`,
        }),
      ),
    );

    // The fixture range is genuinely empty, which is what makes the assertion
    // below about `null` rather than about a coincidence.
    expect(metrics.summary.firstResponse.medianSeconds).toBeNull();
    expect(rows[1]?.[column(rows, 'first_response_median_seconds')]).toBe('');
    expect(rows[1]?.[column(rows, 'first_response_count')]).toBe('0');
  });

  it('gives the series a row per day, matching the screen’s bars', async () => {
    const metrics = await dashboard();
    const rows = parseCsv(await exported({ section: 'series' }));

    expect(rows).toHaveLength(metrics.series.length + 1);
    expect(rows[1]?.[column(rows, 'date')]).toBe(metrics.series[0]?.date);
    expect(rows[1]?.[column(rows, 'created')]).toBe(String(metrics.series[0]?.created));
  });

  it('opens with a BOM and separates records with CRLF, so Excel reads it', async () => {
    const csv = await exported({ section: 'summary' });

    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toContain('\r\n');
  });

  it('neutralises a name a spreadsheet would run as a formula', async () => {
    const { dashboardCsv } = await import('./report-csv');
    const metrics = await dashboard();
    const hostile = "=cmd|' /c calc'!A1";

    const rows = parseCsv(
      dashboardCsv(
        {
          ...metrics,
          agents: metrics.agents.map((agent, index) =>
            index === 0 ? { ...agent, name: hostile } : agent,
          ),
        },
        'agents',
      ),
    );

    // Prefixed, and still readable as the name it is — the cell is inert text
    // rather than something Excel evaluates on open.
    expect(rows[1]?.[0]).toBe(`'${hostile}`);
  });

  it('narrows to one row for a caller without report:read_all, like the screen', async () => {
    currentRole = 'agent';

    const metrics = await dashboard();
    const rows = parseCsv(await exported({ section: 'agents' }));

    // Header, the caller's own rows, and TOTAL — never a colleague's row.
    expect(rows).toHaveLength(metrics.agents.length + 2);
  });
});
