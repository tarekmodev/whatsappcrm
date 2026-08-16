import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  DashboardMetricsResponseSchema,
  REPORT_RANGE_MAX_DAYS,
  permissionsForRole,
  type DashboardMetricsQuery,
  type DashboardMetricsResponse,
  type Permission,
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
import { ANONYMOUS, PRINCIPAL_SOURCE, resolved } from '../rbac/principal.source';
import { AllExceptionsFilter } from '../observability/all-exceptions.filter';
import { AppLoggerService } from '../observability/app-logger.service';
import { ErrorTrackingService } from '../observability/error-tracking.service';
import { ReportingQueryService } from './reporting-query.service';
import { ReportsController } from './reports.controller';
import { ReportTeamNotFoundError } from './reporting.errors';

/**
 * The HTTP contract of `GET /api/v1/reports/dashboard` and its CSV
 * representation at `/export`.
 *
 * One suite for both, against one application: the export is the same answer in
 * another form, so it has to be refused by the same guards, bound out of the
 * same query string and translated by the same error mapping. Splitting it into
 * its own harness would let the two drift apart in exactly the way TAR-30's
 * second acceptance criterion forbids.
 *
 * Proved with the **real** `PrincipalGuard` and `PermissionGuard` registered as
 * `APP_GUARD`, the way `RequestPipelineModule` registers them (TAR-58) — the
 * load-bearing assertion in the first two blocks is that an unauthenticated or
 * under-permissioned caller never reaches the service.
 *
 * ## Why the query binding is asserted through Express
 *
 * Every value on this route arrives as characters in a query string. A schema
 * that is correct against a hand-built object and wrong against
 * `?from=2026-08-01&scope=assigned` passes its own unit test and 400s in
 * production — the gap `tickets.controller.spec.ts` records having been bitten
 * by. These cases go through Express, the pipe and the schema together, which is
 * the only place that is visible.
 */

const TENANT = '25999999-9999-7999-8999-999999999801';
const TEAM = '25999999-9999-7999-8999-9999999998b1';

/** The three bytes every exported file opens with. See the serialiser's spec. */
const BYTE_ORDER_MARK = '\uFEFF';

function principalWith(permissions: readonly Permission[]): SessionPrincipal {
  return {
    userId: '25999999-9999-7999-8999-9999999998d1',
    tenantId: TENANT,
    email: 'sam@example.test',
    displayName: 'Sam Supervisor',
    role: 'supervisor',
    permissions: [...permissions],
    teamIds: [],
    sessionId: '25999999-9999-7999-8999-9999999998e1',
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

const SUPERVISOR = principalWith(permissionsForRole('supervisor'));

/**
 * A silent stand-in for `AppLoggerService`.
 *
 * It has to satisfy two callers, and missing either is a confusing failure
 * rather than a quiet one. `AllExceptionsFilter` calls `structured()` and writes
 * the fault it is rendering to what comes back; `configureApp` passes this same
 * object to `app.useLogger`, so Nest calls the `LoggerService` methods on it
 * during `app.init()` — a stub without `log` fails every test in the file with
 * `this.localInstance?.log is not a function`, pointing at `init` rather than at
 * the stub.
 *
 * Silent because the filter logging a 500 is the filter working; that output
 * belongs in the server log, not in this test's report.
 */
function silentLogger() {
  const pino = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };

  return {
    structured: () => pino,
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  };
}

const REPORT: DashboardMetricsResponse = {
  range: {
    from: '2026-08-01',
    to: '2026-08-07',
    timezone: 'Asia/Riyadh',
    startsAt: '2026-07-31T21:00:00.000Z',
    endsAt: '2026-08-07T21:00:00.000Z',
  },
  scope: 'all',
  summary: {
    volume: { created: 12, resolved: 9, closedWithoutResolution: 2 },
    firstResponse: { count: 9, averageSeconds: 480, medianSeconds: 300, p90Seconds: 1_200 },
    resolution: { count: 9, averageSeconds: 7_200, medianSeconds: 6_000, p90Seconds: 20_000 },
  },
  agents: [
    {
      userId: '25999999-9999-7999-8999-9999999998d2',
      name: 'Ada Agent',
      isActive: true,
      ticketsResolved: 9,
      firstResponse: { count: 9, averageSeconds: 480, medianSeconds: 300, p90Seconds: 1_200 },
      resolution: { count: 9, averageSeconds: 7_200, medianSeconds: 6_000, p90Seconds: 20_000 },
    },
  ],
  series: [{ date: '2026-08-01', created: 12, resolved: 9, firstResponseMedianSeconds: 300 }],
};

describe('the reporting routes', () => {
  let app: INestApplication;
  let server: Server;
  let signedIn: boolean;
  let principal: SessionPrincipal;
  let dashboard: jest.Mock;

  beforeAll(async () => {
    dashboard = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [ReportsController],
      providers: [
        ApiExceptionFilter,
        { provide: ReportingQueryService, useValue: { dashboard } },
        // Read by `configureApp` for the CORS allow-list; nothing here needs it.
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PRINCIPAL_SOURCE,
          useValue: { resolve: () => Promise.resolve(signedIn ? resolved(principal) : ANONYMOUS) },
        },
        { provide: APP_GUARD, useClass: PrincipalGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        // The global filter `ObservabilityModule` installs in production. It is
        // here rather than stubbed because the last case in this file is about
        // what a caller sees when something falls *past* `ApiExceptionFilter` —
        // and without it that assertion would be about Nest's default handler,
        // which is not what the API returns.
        { provide: AppLoggerService, useValue: silentLogger() },
        { provide: ErrorTrackingService, useValue: { captureException: jest.fn() } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    const middleware = app.get(TenantContextMiddleware);
    const tenantContext = app.get(TenantContextService);

    app.use((req: unknown, res: unknown, next: () => void) => {
      (middleware as { use: (a: unknown, b: unknown, c: () => void) => void }).use(req, res, () => {
        tenantContext.setTenant(TENANT);
        next();
      });
    });

    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    signedIn = true;
    principal = SUPERVISOR;
    dashboard.mockResolvedValue(REPORT);
  });

  const url = '/api/v1/reports/dashboard?from=2026-08-01&to=2026-08-07';

  it('refuses an unauthenticated caller before reaching the service', async () => {
    signedIn = false;

    const response = await request(server).get(url).expect(401);

    expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
    expect(dashboard).not.toHaveBeenCalled();
  });

  it('refuses a caller without report:read', async () => {
    principal = principalWith(
      permissionsForRole('supervisor').filter((permission) => permission !== 'report:read'),
    );

    await request(server).get(url).expect(403);
    expect(dashboard).not.toHaveBeenCalled();
  });

  it('lets an agent in — the narrowing happens in the service, not at the door', async () => {
    // ADR 0004 invariant 2: an agent opening a supervisor's dashboard URL gets a
    // dashboard with less in it. A 403 here would make that a broken link.
    principal = principalWith(permissionsForRole('agent'));

    await request(server).get(url).expect(200);
    expect(dashboard).toHaveBeenCalledTimes(1);
  });

  it('returns the published shape', async () => {
    const response = await request(server).get(url).expect(200);

    expect(DashboardMetricsResponseSchema.parse(response.body)).toEqual(REPORT);
  });

  it('binds the range and the defaults out of the query string', async () => {
    await request(server).get(url).expect(200);

    expect(dashboard).toHaveBeenCalledWith({
      from: '2026-08-01',
      to: '2026-08-07',
      scope: 'all',
      assignedTeamId: undefined,
    });
  });

  it('binds an explicit scope and team filter', async () => {
    await request(server).get(`${url}&scope=assigned&assignedTeamId=${TEAM}`).expect(200);

    expect(dashboard).toHaveBeenCalledWith({
      from: '2026-08-01',
      to: '2026-08-07',
      scope: 'assigned',
      assignedTeamId: TEAM,
    });
  });

  it('requires a range rather than inventing one', async () => {
    // A dashboard that silently picks a period shows numbers for something
    // nobody asked about.
    const response = await request(server).get('/api/v1/reports/dashboard').expect(400);

    expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
    expect(dashboard).not.toHaveBeenCalled();
  });

  it('refuses a reversed range', async () => {
    await request(server)
      .get('/api/v1/reports/dashboard?from=2026-08-07&to=2026-08-01')
      .expect(400);

    expect(dashboard).not.toHaveBeenCalled();
  });

  it('refuses a range over the cap before any SQL runs', async () => {
    // The bound on the one query whose row count the caller chooses. It has to
    // be refused by the schema, not discovered by a statement timeout.
    const response = await request(server)
      .get('/api/v1/reports/dashboard?from=2026-01-01&to=2027-01-02')
      .expect(400);

    expect(ApiErrorSchema.parse(response.body).error.message).toBeDefined();
    expect(REPORT_RANGE_MAX_DAYS).toBe(366);
    expect(dashboard).not.toHaveBeenCalled();
  });

  it('refuses an instant where a tenant-local date belongs', async () => {
    await request(server)
      .get('/api/v1/reports/dashboard?from=2026-08-01T00:00:00Z&to=2026-08-07')
      .expect(400);

    expect(dashboard).not.toHaveBeenCalled();
  });

  it('answers not_found for a team this tenant does not have', async () => {
    // Never `forbidden`: a 403 would confirm the id names a real team
    // somewhere, which is the enumeration 0002's security section forbids.
    dashboard.mockRejectedValue(new ReportTeamNotFoundError(TEAM));

    const response = await request(server).get(`${url}&assignedTeamId=${TEAM}`).expect(404);

    expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
  });

  it('reports an exhausted statement budget as a server fault, not a bad request', async () => {
    // 0010's error table. The range is already capped, so there is nothing the
    // caller could ask differently — it is a capacity fault on our side and
    // takes the generic server answer.
    //
    // Deliberately **not** translated by `translateReportingFailure`: it falls
    // through to Nest's default handler, which is what `ApiExceptionFilter`'s
    // own docblock says happens to anything that is not an `ApiException` (the
    // global filter is TAR-41's). What matters at this boundary is the second
    // assertion — the statement text reaches the log, never the client.
    dashboard.mockRejectedValue(new Error('canceling statement due to statement timeout'));

    const response = await request(server).get(url).expect(500);
    const { error } = ApiErrorSchema.parse(response.body);

    expect(error.code).toBe('internal_error');
    // The correlation id is the whole answer a caller gets to "what went
    // wrong" — the detail is on the server side of it.
    expect(error.requestId).toEqual(expect.any(String));
    // Not asserted here: that the message itself is redacted. `AllExceptionsFilter`
    // only replaces it when `NODE_ENV=production`, and
    // `all-exceptions.filter.spec.ts` is where that switch is proved. Duplicating
    // it here would pass for the wrong reason under a test environment.
  });

  /**
   * `GET /api/v1/reports/dashboard/export` (TAR-430).
   *
   * The same harness deliberately: the export is the JSON route's answer in
   * another representation, so it has to be refused by the same guards, bound
   * out of the same query string and translated by the same error mapping. A
   * separate suite with its own app would be able to drift from the route it
   * is a representation of, which is the whole failure mode this story exists
   * to close.
   *
   * What the values in the file are is asserted in
   * `dashboard-csv.serialiser.spec.ts` and, against the JSON route,
   * `dashboard-export-parity.spec.ts`. This block is the HTTP contract: who is
   * let in, what is asked of the query layer, and what comes back on the wire.
   */
  describe('the CSV export', () => {
    const exportUrl = '/api/v1/reports/dashboard/export?from=2026-08-01&to=2026-08-07';

    it('refuses an unauthenticated caller before reaching the service', async () => {
      signedIn = false;

      const response = await request(server).get(exportUrl).expect(401);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
      expect(dashboard).not.toHaveBeenCalled();
    });

    it('refuses a caller without report:read', async () => {
      principal = principalWith(
        permissionsForRole('supervisor').filter((permission) => permission !== 'report:read'),
      );

      await request(server).get(exportUrl).expect(403);
      expect(dashboard).not.toHaveBeenCalled();
    });

    /**
     * Every header here is load-bearing. Without the attachment disposition and
     * `nosniff` a browser may decide a CSV is a page and run it on the API
     * origin; without `no-store` a tenant's numbers can sit in a shared cache.
     */
    it('serves the bytes as a private, non-sniffable attachment', async () => {
      const response = await request(server).get(exportUrl).expect(200);

      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="report-agents-2026-08-01-2026-08-07.csv"',
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.text));
    });

    it('names the file after the section that was asked for', async () => {
      const response = await request(server).get(`${exportUrl}&section=series`).expect(200);

      expect(response.headers['content-disposition']).toContain(
        'report-series-2026-08-01-2026-08-07.csv',
      );
    });

    /**
     * The mechanism behind TAR-30's second acceptance criterion, asserted at
     * the seam where it could break: whatever section the export was asked for,
     * the query layer sees the dashboard's parameters and nothing else.
     *
     * `section` chooses a serialiser. An export that passed it through to the
     * aggregation would be making a query the dashboard never makes, which is
     * the first step towards two code paths.
     */
    it.each(['summary', 'agents', 'series'])(
      'asks the query layer for exactly what the dashboard would, for %s',
      async (section) => {
        await request(server).get(`${url}&scope=assigned&assignedTeamId=${TEAM}`).expect(200);
        await request(server)
          .get(`${exportUrl}&scope=assigned&assignedTeamId=${TEAM}&section=${section}`)
          .expect(200);

        const asked = dashboard.mock.calls as [DashboardMetricsQuery][];
        const [fromDashboard, fromExport] = asked.map(([sent]) => sent);

        expect(fromExport).toEqual(fromDashboard);
        expect(fromExport).not.toHaveProperty('section');
      },
    );

    it('defaults to the agents section, the one that carries the summary too', async () => {
      const response = await request(server).get(exportUrl).expect(200);

      expect(response.text.replace(BYTE_ORDER_MARK, '').startsWith('row,user_id,name')).toBe(true);
    });

    it('refuses a section the contract does not publish, before any query runs', async () => {
      await request(server).get(`${exportUrl}&section=pdf`).expect(400);

      expect(dashboard).not.toHaveBeenCalled();
    });

    /**
     * Both routes parse against schemas built from one object shape, so a range
     * the screen refuses and the export accepts cannot happen. Asserted through
     * Express for the reason this file's header gives.
     */
    it.each([
      ['a missing range', ''],
      ['a reversed range', '?from=2026-08-07&to=2026-08-01'],
      ['a range over the cap', '?from=2026-01-01&to=2027-01-02'],
      ['an instant where a tenant-local date belongs', '?from=2026-08-01T00:00:00Z&to=2026-08-07'],
    ])('refuses %s, the same as the JSON route', async (_case, query) => {
      const [json, csv] = await Promise.all([
        request(server).get(`/api/v1/reports/dashboard${query}`),
        request(server).get(`/api/v1/reports/dashboard/export${query}`),
      ]);

      expect([json.status, csv.status]).toEqual([400, 400]);
      expect(ApiErrorSchema.parse(csv.body).error.code).toBe('validation_failed');
      expect(dashboard).not.toHaveBeenCalled();
    });

    it('answers not_found for a team this tenant does not have', async () => {
      dashboard.mockRejectedValue(new ReportTeamNotFoundError(TEAM));

      const response = await request(server).get(`${exportUrl}&assignedTeamId=${TEAM}`).expect(404);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
    });
  });
});
