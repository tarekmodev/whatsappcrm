import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import {
  DashboardMetricsQuerySchema,
  type DashboardMetricsQuery,
  type DashboardMetricsResponse,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
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
 * ## What is not here
 *
 * `GET /api/v1/reports/dashboard/export` (TAR-430), additive to this controller
 * when it lands. It is a separate route rather than `?format=csv` on this one
 * for reasons that have nothing to do with where the numbers come from: 0002's
 * `SerializerInterceptor` parses every outbound payload against a response
 * schema, and a route that returns a typed object on Monday and a byte stream on
 * Tuesday has no response schema to be described by. `MediaController.content`
 * already established that shape.
 *
 * The parity guarantee lives one layer down and is unaffected by that split:
 * both routes call `ReportingQueryService.dashboard()` with the same parsed
 * query object, and the CSV route serialises the result rather than querying
 * again.
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
}
