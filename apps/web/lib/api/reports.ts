import 'server-only';

import {
  DashboardMetricsResponseSchema,
  type DashboardMetricsQuery,
  type DashboardMetricsResponse,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * The reporting read surface, per ADR 0009.
 *
 * One endpoint today. `GET /reports/dashboard/export` is TAR-430's, and it is
 * deliberately not modelled here: it answers bytes rather than JSON, so it needs
 * the browser transport and a `Blob`, not this server-side one.
 */

const REPORTS_PATH = '/v1/reports/dashboard';

/**
 * `GET /api/v1/reports/dashboard`.
 *
 * **The query is serialised in one place, and that is the point.** TAR-431's
 * export control has to send exactly the parameters the screen was rendered
 * from, so the search string is built here from the parsed query object rather
 * than assembled per call site.
 *
 * Tenant scoping is the API's, from the session cookie — there is no tenant
 * parameter to get wrong. `scope` is narrowed rather than refused for a caller
 * without `report:read_all`, so the response says which scope was actually
 * served and the console reads that rather than what it asked for.
 */
export async function getDashboardMetrics(
  query: DashboardMetricsQuery,
): Promise<DashboardMetricsResponse> {
  const response = await authenticatedRequest({
    method: 'GET',
    path: `${REPORTS_PATH}?${dashboardSearchParams(query).toString()}`,
  });

  return DashboardMetricsResponseSchema.parse(response);
}

/** Exported so TAR-431's export URL is the same serialisation, not a second one. */
export function dashboardSearchParams(query: DashboardMetricsQuery): URLSearchParams {
  const params = new URLSearchParams({ from: query.from, to: query.to, scope: query.scope });

  if (query.assignedTeamId !== undefined) {
    params.set('assignedTeamId', query.assignedTeamId);
  }

  return params;
}
