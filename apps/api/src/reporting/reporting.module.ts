import { Module } from '@nestjs/common';
import { ReportRangeResolver } from './report-range.resolver';
import { ReportingQueryService } from './reporting-query.service';
import { ReportsController } from './reports.controller';

/**
 * The reporting dashboard (TAR-30), built against
 * `docs/architecture/0010-reporting-dashboard-and-export.md`.
 *
 * An **L4 module** per ADR 0002's table. It may import L3 domain modules;
 * nothing below it may import it. Today it imports nothing at all —
 * `TenantPrisma` comes from the global `PrismaModule` and
 * `TenantContextService` from `TenantContextModule` — and it exports nothing:
 * its whole public surface is one HTTP controller.
 *
 * | Provider               | Responsibility                                                        |
 * | ---------------------- | --------------------------------------------------------------------- |
 * | `ReportRangeResolver`  | Tenant-local `from`/`to` → a half-open instant interval               |
 * | `ReportingQueryService`| **The only place aggregation SQL lives.** Returns one dashboard       |
 * | `ReportsController`    | `GET /reports/dashboard` and `GET /reports/dashboard/export`         |
 *
 * `serialiseDashboardCsv` is a function rather than a provider, and that is the
 * design showing through the wiring: it takes the object the query service
 * already returns, touches no database and holds no state, so there is nothing
 * for the container to inject into it. The day it needs a dependency is the day
 * the export has grown a second source of numbers.
 *
 * ## Its operational surface is the whole of "it is a read"
 *
 * No queue, no worker, no scheduled job, no realtime event, no cache. Reporting
 * is a synchronous read, and that is a property of the design rather than
 * something not built yet: nothing here has a delivery guarantee to miss or
 * state to diverge, so **nothing in this module should ever page anyone**. A
 * Redis outage does not touch it. A slow Postgres makes the dashboard slow, and
 * a retry is free.
 *
 * A cache is deliberately absent too. The range is caller-chosen so the hit rate
 * would be poor, and a cached report is a staleness bug wearing a performance
 * costume — "matches what's shown on screen" is trivially true only while both
 * reads hit the same table in the same second.
 *
 * ## Tenant scoping adds no second binding point
 *
 * `TenantPrisma` only. This module adds **no** `SystemPrisma` call site, so the
 * written list in `docs/reference/tenancy.md` is unchanged. That is what
 * satisfies TAR-426's "confirms the tenant-scoping mechanism established in
 * TAR-39/TAR-19" for this story.
 *
 * ## What is not here
 *
 * A row-level (per-ticket) export, and scheduled or emailed reports. 0010 names
 * both as the triggers for revisiting the synchronous shape, and both would
 * call this same query layer rather than growing one of their own.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportRangeResolver, ReportingQueryService],
})
export class ReportingModule {}
