import { Controller, Get, Query, Res, UseFilters } from '@nestjs/common';
import {
  DashboardExportQuerySchema,
  DashboardMetricsQuerySchema,
  type DashboardExportQuery,
  type DashboardMetricsQuery,
  type DashboardMetricsResponse,
} from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { serialiseDashboardCsv } from './dashboard-csv.serialiser';
import { reportContentDisposition, reportExportFileName } from './report-export-file-name';
import { ReportingQueryService } from './reporting-query.service';
import { translateReportingFailure } from './reporting.http';

/**
 * The reporting dashboard's read surface (TAR-30, ADR 0010's endpoint table).
 *
 * It declares no guards. `RequestPipelineModule` runs all three on every route
 * in the application — where the request is, who is making it, then whether they
 * may — so the route below states only its permission.
 *
 * ## `report:read`, widened rather than gated by `report:read_all`
 *
 * Every role holds `report:read`; supervisor and admin also hold
 * `report:read_all`. The wider permission is **not** on the decorator, and that
 * is the decision rather than an omission: ADR 0004 invariant 2 requires this
 * surface to narrow instead of refusing, so an agent opening a supervisor's
 * dashboard URL gets a valid dashboard covering their own visible set — with the
 * scope it actually used echoed in the response, which is what stops a narrowed
 * view reading as data loss. `ReportingQueryService` owns both halves of that
 * narrowing.
 *
 * ## Two routes, one query and two serialisations
 *
 * The CSV is a separate route rather than `?format=csv` on the JSON one, for
 * reasons that have nothing to do with where the numbers come from: 0002's
 * `SerializerInterceptor` parses every outbound payload against a response
 * schema, and a route that returns a typed object on Monday and a byte stream on
 * Tuesday has no response schema to be described by. The bytes also need their
 * headers set before the first byte, and export is the most expensive `GET` in
 * the product — keeping it distinct means it can take its own rate limit, log
 * line and timeout later without splitting a route the console depends on.
 * `MediaController.content` already established that shape, and `export` is a
 * representation of the dashboard rather than a nested collection, so it does
 * not breach 0002's one-level nesting rule for the same reason that route does
 * not.
 *
 * The parity guarantee is unaffected by that split, because it lives one layer
 * down: both handlers call `ReportingQueryService.dashboard()` with a query
 * built from one object shape, and the CSV route hands the result to a
 * serialiser that touches no database. **There is no SQL on the export path.**
 * `dashboard-export-parity.spec.ts` asserts it end to end — the CSV, parsed
 * back, carries the values the JSON body carries for the same query string.
 *
 * ## No `Idempotency-Key`, no cursor
 *
 * Safe and idempotent — nothing is written, so a replay is free. And no
 * pagination: the response is bounded by the tenant's agent count and by the
 * range cap, not by a growing table, so there is no page for a cursor to
 * resume. The bound that matters is `REPORT_RANGE_MAX_DAYS`, enforced by the
 * schema before any SQL runs.
 */
@Controller({ path: 'reports', version: '1' })
@UseFilters(ApiExceptionFilter)
export class ReportsController {
  constructor(private readonly reports: ReportingQueryService) {}

  /**
   * `GET /api/v1/reports/dashboard` — response time, resolution time, ticket
   * volume and the per-agent breakdown over a supervisor-chosen date range.
   *
   * `from` and `to` are tenant-local calendar dates and are required: there is
   * no default range, because a dashboard that silently picks one shows numbers
   * for a period nobody asked about.
   */
  @Get('dashboard')
  @RequirePermission('report:read')
  dashboard(
    @Query(new ZodValidationPipe(DashboardMetricsQuerySchema)) query: DashboardMetricsQuery,
  ): Promise<DashboardMetricsResponse> {
    return this.reports.dashboard(query).catch(translateReportingFailure);
  }

  /**
   * `GET /api/v1/reports/dashboard/export` — the same numbers, as CSV
   * (TAR-430).
   *
   * `toMetricsQuery` is the whole of the difference between this call and the
   * one above: it drops `section`, which chooses a serialiser and never reaches
   * a statement. Everything else the caller sent goes to the query layer
   * unchanged, which is what makes the file and the screen the same numbers
   * rather than two readings that happen to agree.
   *
   * `@Res()` rather than a return value, because the headers are the point and
   * they have to be set before the first byte. Each of them, and why — the same
   * set `MediaController.content` emits, for the same reasons:
   *
   *   * `Content-Type: text/csv; charset=utf-8`, declaring the encoding the
   *     serialiser's byte-order mark also announces;
   *   * `Content-Disposition: attachment`, with the section and range in the
   *     file name;
   *   * `X-Content-Type-Options: nosniff`, so a browser cannot decide the file
   *     is HTML and run it on this origin;
   *   * `Content-Length`, so a truncated transfer is detectable;
   *   * `Cache-Control: private, no-store`. A tenant's numbers must not sit in a
   *     shared cache, and this response is authorised by a session that can be
   *     revoked.
   *
   * The body is built in full before the first header goes out rather than
   * streamed, and that is a bound rather than an oversight: a section is the
   * range's aggregate — one row, one row per agent, or one row per day of a
   * range capped at `REPORT_RANGE_MAX_DAYS` — so the largest file this can
   * produce is a few hundred rows. A row-level export would not have that
   * property, which is one of the two triggers 0010 names for revisiting the
   * synchronous shape.
   */
  @Get('dashboard/export')
  @RequirePermission('report:read')
  async export(
    @Query(new ZodValidationPipe(DashboardExportQuerySchema)) query: DashboardExportQuery,
    @Res() response: Response,
  ): Promise<void> {
    const metrics = await this.reports
      .dashboard(toMetricsQuery(query))
      .catch(translateReportingFailure);

    const body = serialiseDashboardCsv(metrics, query.section);

    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-length', body.byteLength);
    response.setHeader(
      'content-disposition',
      reportContentDisposition(reportExportFileName(query)),
    );
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'private, no-store');

    response.end(body);
  }
}

/**
 * The export's query, as the metrics query — which is all of it but `section`.
 *
 * Written out field by field rather than as a rest spread, so that adding a
 * filter to `dashboardQueryShape` and forgetting it here fails to compile
 * instead of quietly exporting an unfiltered report. That is the failure this
 * function exists to make impossible: an export that silently ignores a filter
 * the screen applied is precisely the drift TAR-30's second acceptance
 * criterion is about, and it would look correct in every test that only checks
 * whether the numbers add up.
 */
function toMetricsQuery(query: DashboardExportQuery): DashboardMetricsQuery {
  return {
    from: query.from,
    to: query.to,
    scope: query.scope,
    assignedTeamId: query.assignedTeamId,
  };
}
