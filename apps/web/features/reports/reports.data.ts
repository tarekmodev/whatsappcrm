import 'server-only';

import type { DashboardMetricsResponse } from '@whatsappcrm/contracts';
import { getDashboardMetrics } from '@/lib/api/reports';
import type { ReportParams } from '@/features/reports/report-params';

/**
 * The dashboard's one read.
 *
 * One request, not four: the summary, the per-agent rows and the daily series
 * come back from a single aggregation, which is what makes the total and the
 * breakdown incapable of disagreeing — ADR 0010 (reporting dashboard and export)
 * decision 1. Splitting them into three fetches to get three Suspense boundaries
 * would buy a little streaming and give away the one property the whole design
 * turns on.
 *
 * Tenant scoping is the API's, resolved from the session; there is no tenant
 * parameter here to get wrong. `scope` comes back as the scope that was actually
 * served, which is not always the one that was asked for — a caller without
 * `report:read_all` is narrowed rather than refused, and the screen reads the
 * response rather than its own request to know which happened.
 */
export async function loadDashboardMetrics(
  params: ReportParams,
): Promise<DashboardMetricsResponse> {
  return getDashboardMetrics(params);
}
