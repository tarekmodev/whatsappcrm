import 'server-only';

import {
  DashboardMetricsResponseSchema,
  type DashboardExportQuery,
  type DashboardMetricsQuery,
  type DashboardMetricsResponse,
} from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { authenticatedRequest } from '@/lib/api/authenticated';
import { reportSearchParams } from '@/features/reports/report-params';

/**
 * The reporting read surface, per ADR 0010 (reporting dashboard and export).
 *
 * `GET /reports/dashboard/export` answers bytes rather than JSON, so the console
 * fetches it from the **browser** (`lib/api/reports-browser.ts`) — a link cannot
 * render an error state, and this transport parses every response as JSON. The
 * one exception is mock mode, below, where the fixtures only exist on this
 * process.
 *
 * The query is serialised in exactly one place — `reportSearchParams` — so the
 * export sends the parameters the screen was rendered from rather than a second
 * reading of them.
 */

const REPORTS_PATH = '/v1/reports/dashboard';

/**
 * `GET /api/v1/reports/dashboard`.
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
    path: `${REPORTS_PATH}?${reportSearchParams(query).toString()}`,
  });

  return DashboardMetricsResponseSchema.parse(response);
}

/**
 * The export's CSV **in mock mode only**, where the fixture transport lives on
 * this process and the browser has nothing to fetch from.
 *
 * Against a real API the export never comes through here: it is a browser fetch
 * that keeps the bytes, the `Content-Disposition` name and any failure inside the
 * page. Refused rather than quietly proxied, because this transport parses every
 * response as JSON and would turn a perfectly good CSV into a parse error at the
 * one call site least able to explain it.
 */
export async function getMockDashboardExportCsv(query: DashboardExportQuery): Promise<string> {
  if (!webEnv.useMockApi) {
    throw new Error('The dashboard export is fetched by the browser unless mock mode is on.');
  }

  const { section, ...metricsQuery } = query;

  const response = await authenticatedRequest({
    method: 'GET',
    path: `${REPORTS_PATH}/export?${reportSearchParams(metricsQuery, section).toString()}`,
  });

  return String(response);
}
