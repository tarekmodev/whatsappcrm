import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  DashboardMetricsResponseSchema,
  permissionsForRole,
  reportRangeDays,
  type DashboardMetricsQuery,
  type DashboardMetricsResponse,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { PRINCIPAL_SOURCE, resolved } from '../rbac/principal.source';
import { ReportingQueryService } from './reporting-query.service';
import { ReportsController } from './reports.controller';

/**
 * **TAR-30's second acceptance criterion, asserted directly**: for the same
 * date range and filters, the exported file carries the values the dashboard
 * API returns.
 *
 * Not eyeballed and not compared field by field against a hand-written
 * expectation — the CSV is fetched over HTTP, parsed back with a strict RFC
 * 4180 reader, and the whole reconstructed structure is compared to the JSON
 * body from the other route for the same query string. Every section is
 * covered, across four different ranges and filter combinations, because a
 * parity bug that only shows up under a non-default filter is exactly the kind
 * this test exists to catch.
 *
 * ## Why the stub answers from the query rather than with a constant
 *
 * A stub that returns the same object whatever it is asked would make this test
 * pass even if the export queried a different range from the dashboard —
 * the numbers would match because they could not do anything else. So the query
 * layer here **derives its answer from the query it received**: the range and
 * the scope come back inside the response, and the counts are a function of the
 * range's length. An export that dropped a filter, widened a range or reordered
 * the parameters produces a different response, and the comparison fails.
 *
 * ADR 0010 (reporting dashboard and export) makes the property structural — there
 * is one query layer, one filter parse and no SQL on the export path — so this is
 * a regression test for something the design already guarantees, rather than the
 * only thing holding it up. That is the point: it fails the day somebody adds a
 * second path.
 */

const TENANT_ID = '9c0c1f60-3a41-7a2e-8f0e-0b3d5a1c0100';
const TEAM_ID = '9c0c1f60-3a41-7a2e-8f0e-0b3d5a1c0103';
const AGENT_IDS = [
  '9c0c1f60-3a41-7a2e-8f0e-0b3d5a1c0201',
  '9c0c1f60-3a41-7a2e-8f0e-0b3d5a1c0202',
] as const;

/**
 * Names chosen to exercise the serialiser's text handling through the
 * comparison rather than beside it: a comma forces quoting, a double quote
 * forces doubling, Arabic forces the BOM to do its job, and a formula lead
 * forces the injection guard. If any of those transformations were lossy, the
 * value that comes back would not be the value the JSON carries.
 */
const AGENT_NAMES = ['ليلى, المشرفة', '=cmd|\' /c calc\'!A1 "ops"'] as const;

const PRINCIPAL: SessionPrincipal = {
  userId: AGENT_IDS[0],
  tenantId: TENANT_ID,
  email: 'supervisor@example.invalid',
  displayName: 'Layla Supervisor',
  role: 'supervisor',
  permissions: [...permissionsForRole('supervisor')],
  teamIds: [TEAM_ID],
  sessionId: '9c0c1f60-3a41-7a2e-8f0e-0b3d5a1c0102',
  expiresAt: '2036-12-31T23:59:59.000Z',
};

// ---------------------------------------------------------------------------
// The stubbed query layer
// ---------------------------------------------------------------------------

function addDays(from: string, days: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Deterministic, and different for every query — see the note above. */
function answerFor(query: DashboardMetricsQuery): DashboardMetricsResponse {
  const days = reportRangeDays(query.from, query.to);
  const narrowed = query.assignedTeamId === undefined ? 1 : 2;

  return DashboardMetricsResponseSchema.parse({
    range: {
      from: query.from,
      to: query.to,
      timezone: 'Asia/Riyadh',
      startsAt: `${query.from}T21:00:00.000Z`,
      endsAt: `${addDays(query.to, 1)}T21:00:00.000Z`,
    },
    scope: query.scope,
    summary: {
      volume: {
        created: days * 3,
        resolved: days * 2,
        closedWithoutResolution: narrowed,
      },
      firstResponse: {
        count: days,
        averageSeconds: 300 + days,
        medianSeconds: 240 + narrowed,
        p90Seconds: 900 + days,
      },
      resolution: {
        count: days,
        averageSeconds: 7200 + days,
        medianSeconds: 7000 + narrowed,
        p90Seconds: 18_000 + days,
      },
    },
    agents: [
      {
        userId: AGENT_IDS[0],
        name: AGENT_NAMES[0],
        isActive: true,
        ticketsResolved: days,
        firstResponse: {
          count: days,
          averageSeconds: 300,
          medianSeconds: 240,
          p90Seconds: 900,
        },
        resolution: { count: days, averageSeconds: 7200, medianSeconds: 7000, p90Seconds: 18_000 },
      },
      {
        userId: AGENT_IDS[1],
        name: AGENT_NAMES[1],
        isActive: false,
        ticketsResolved: 0,
        // Nothing measured: null durations, which must survive the round trip
        // as null rather than coming back as zero.
        firstResponse: { count: 0, averageSeconds: null, medianSeconds: null, p90Seconds: null },
        resolution: { count: 0, averageSeconds: null, medianSeconds: null, p90Seconds: null },
      },
      {
        userId: null,
        name: null,
        isActive: false,
        ticketsResolved: narrowed,
        firstResponse: { count: 1, averageSeconds: 60, medianSeconds: 60, p90Seconds: 60 },
        resolution: { count: 1, averageSeconds: 600, medianSeconds: 600, p90Seconds: 600 },
      },
    ],
    series: Array.from({ length: days }, (_unused, index) => ({
      date: addDays(query.from, index),
      created: index === 1 ? 0 : 3,
      resolved: index === 1 ? 0 : 2,
      firstResponseMedianSeconds: index === 1 ? null : 240 + index,
    })),
  });
}

// ---------------------------------------------------------------------------
// Reading the file back
// ---------------------------------------------------------------------------

/**
 * A strict RFC 4180 reader, written here rather than taken from a package: a
 * parity assertion that leaned on a permissive parser could hide the very
 * defects it is meant to catch — an unclosed quote, a stray `\n`, a doubled
 * quote left undoubled. This one refuses all three.
 */
function parseCsv(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < body.length) {
    const character = body[index];

    if (quoted) {
      if (character === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }

        quoted = false;
        index += 1;
        continue;
      }

      field += character;
      index += 1;
      continue;
    }

    if (character === '"') {
      if (field !== '') {
        throw new Error(`A quote opens mid-field at offset ${index}.`);
      }

      quoted = true;
      index += 1;
      continue;
    }

    if (character === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }

    if (character === '\r') {
      if (body[index + 1] !== '\n') {
        throw new Error(`A carriage return without a line feed at offset ${index}.`);
      }

      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 2;
      continue;
    }

    if (character === '\n') {
      throw new Error(`A bare line feed at offset ${index}; RFC 4180 rows end with CRLF.`);
    }

    field += character;
    index += 1;
  }

  if (quoted) {
    throw new Error('The file ends inside a quoted field.');
  }

  if (field !== '' || row.length > 0) {
    throw new Error('The file does not end with a line ending.');
  }

  return rows;
}

const FORMULA_LEAD_CHARACTERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * The inverse of the serialiser's formula guard, and only that: a leading quote
 * is removed exactly when the character after it is one a spreadsheet would
 * have read as a formula. A name that genuinely begins with an apostrophe was
 * never prefixed, so it must not be stripped either.
 */
function readText(cell: string | undefined): string | null {
  const value = required(cell);

  if (value === '') {
    return null;
  }

  return value.startsWith("'") && FORMULA_LEAD_CHARACTERS.includes(value.charAt(1))
    ? value.slice(1)
    : value;
}

function readNumber(cell: string | undefined): number | null {
  const value = required(cell);

  return value === '' ? null : Number(value);
}

/**
 * A column the comparison needs and the row does not have.
 *
 * Raised rather than defaulted to an empty string: a short row means the file
 * has fewer columns than the reader expects, which is a serialiser defect, and
 * quietly reading it as null would turn that into a mismatch reported against
 * whichever value happened to shift.
 */
function required(cell: string | undefined): string {
  if (cell === undefined) {
    throw new Error('The exported row is missing a column the comparison reads.');
  }

  return cell;
}

function readDuration(cells: string[]): unknown {
  const [count, averageSeconds, medianSeconds, p90Seconds] = cells;

  return {
    count: Number(count),
    averageSeconds: readNumber(averageSeconds),
    medianSeconds: readNumber(medianSeconds),
    p90Seconds: readNumber(p90Seconds),
  };
}

/**
 * The row a section is expected to have, or a failure naming what was missing.
 *
 * The `summary` file is one header and one row, so a missing second row is not
 * a case to default around — it is an export that produced nothing, and the
 * comparison should say so rather than compare `undefined` against the JSON.
 */
function rowAt(rows: string[][], index: number): string[] {
  const row = rows[index];

  if (row === undefined) {
    throw new Error(`The export has no row ${index}.`);
  }

  return row;
}

/** The `summary` file, back as the pieces of the JSON body it was made from. */
function readSummarySection(csv: string): unknown {
  const row = rowAt(parseCsv(csv), 1);

  return {
    range: { from: row[0], to: row[1], timezone: row[2] },
    scope: row[3],
    summary: {
      volume: {
        created: Number(row[4]),
        resolved: Number(row[5]),
        closedWithoutResolution: Number(row[6]),
      },
      firstResponse: readDuration(row.slice(7, 11)),
      resolution: readDuration(row.slice(11, 15)),
    },
  };
}

function readAgentsSection(csv: string): unknown {
  const [, ...rows] = parseCsv(csv);
  const total = rowAt(rows, rows.length - 1);

  return {
    agents: rows.slice(0, -1).map((row) => ({
      userId: readText(row[1]),
      name: readText(row[2]),
      isActive: row[3] === 'true',
      ticketsResolved: Number(row[4]),
      firstResponse: readDuration(row.slice(5, 9)),
      resolution: readDuration(row.slice(9, 13)),
    })),
    total: {
      ticketsResolved: Number(total[4]),
      firstResponse: readDuration(total.slice(5, 9)),
      resolution: readDuration(total.slice(9, 13)),
    },
  };
}

function readSeriesSection(csv: string): unknown {
  const [, ...rows] = parseCsv(csv);

  return rows.map((row) => ({
    date: row[0],
    created: Number(row[1]),
    resolved: Number(row[2]),
    firstResponseMedianSeconds: readNumber(row[3]),
  }));
}

// ---------------------------------------------------------------------------
// The specs
// ---------------------------------------------------------------------------

const QUERIES = {
  'a default week': 'from=2026-08-01&to=2026-08-07',
  'a single day': 'from=2026-08-01&to=2026-08-01',
  'a scope the caller narrowed': 'from=2026-08-01&to=2026-08-05&scope=assigned',
  'a team filter': `from=2026-08-01&to=2026-08-04&scope=all&assignedTeamId=${TEAM_ID}`,
};

describe('the export carries the same values as the dashboard', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [ReportsController],
      providers: [
        ApiExceptionFilter,
        {
          provide: ReportingQueryService,
          useValue: {
            dashboard: (query: DashboardMetricsQuery) => Promise.resolve(answerFor(query)),
          },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PRINCIPAL_SOURCE,
          useValue: { resolve: () => Promise.resolve(resolved(PRINCIPAL)) },
        },
        { provide: APP_GUARD, useClass: PrincipalGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    const middleware = app.get(TenantContextMiddleware);
    const tenantContext = app.get(TenantContextService);

    app.use(middleware.use.bind(middleware));
    app.use((_request: unknown, _response: unknown, next: () => void) => {
      tenantContext.setTenant(TENANT_ID);
      next();
    });

    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  async function bothFor(query: string, section: string) {
    const [metrics, csv] = await Promise.all([
      request(server).get(`/api/v1/reports/dashboard?${query}`),
      request(server).get(`/api/v1/reports/dashboard/export?${query}&section=${section}`),
    ]);

    expect(metrics.status).toBe(200);
    expect(csv.status).toBe(200);

    return {
      metrics: DashboardMetricsResponseSchema.parse(metrics.body),
      csv: csv.text,
    };
  }

  describe.each(Object.entries(QUERIES))('for %s', (_case, query) => {
    it('reports the same range, scope and headline numbers in the summary file', async () => {
      const { metrics, csv } = await bothFor(query, 'summary');

      expect(readSummarySection(csv)).toEqual({
        range: {
          from: metrics.range.from,
          to: metrics.range.to,
          timezone: metrics.range.timezone,
        },
        scope: metrics.scope,
        summary: metrics.summary,
      });
    });

    it('reports the same per-agent rows, and a total row that is the summary', async () => {
      const { metrics, csv } = await bothFor(query, 'agents');

      expect(readAgentsSection(csv)).toEqual({
        agents: metrics.agents,
        total: {
          ticketsResolved: metrics.summary.volume.resolved,
          firstResponse: metrics.summary.firstResponse,
          resolution: metrics.summary.resolution,
        },
      });
    });

    it('reports the same daily series, every day of it', async () => {
      const { metrics, csv } = await bothFor(query, 'series');

      expect(readSeriesSection(csv)).toEqual(metrics.series);
    });
  });

  /**
   * The guard against the stub making this suite vacuous. If the export ever
   * asked for a different range than the dashboard, these responses would
   * differ — so a test that could not tell them apart would prove nothing.
   */
  it('would notice if the two routes asked for different ranges', async () => {
    const week = await bothFor('from=2026-08-01&to=2026-08-07', 'summary');
    const day = await bothFor('from=2026-08-01&to=2026-08-01', 'summary');

    expect(readSummarySection(week.csv)).not.toEqual(readSummarySection(day.csv));
  });
});
