import type { DashboardExportQuery } from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { toApiRequestError } from '@/lib/api/error';
import { reportSearchParams } from '@/features/reports/report-params';
import { exportDashboardCsvAction } from '@/features/reports/reports.actions';

/**
 * `GET /api/v1/reports/dashboard/export` — the CSV behind the dashboard's export
 * control. ADR 0010 (reporting dashboard and export), TAR-431.
 *
 * Made **by the browser**, and fetched rather than linked. The frontend notes in
 * that ADR give the reason: a bare `<a download>` cannot fail visibly. A refused or
 * timed-out export would navigate the tab to a JSON error body, which is neither
 * an error state nor a download, and the supervisor would be left reading an
 * envelope. Fetching keeps the failure in the page, where the control can say
 * what happened and offer the retry.
 *
 * It takes the applied query object and serialises it with `reportSearchParams`,
 * the same function the metrics read uses — so the file and the screen are the
 * same parameters by construction, not by convention.
 *
 * `credentials: 'include'` and nothing else: the session is the httpOnly cookie
 * the API set, no token is read or forwarded, and the same-origin `/api` path
 * `next.config.mjs` rewrites is what keeps that cookie first-party under a
 * white-label domain.
 */

export interface DashboardExportFile {
  readonly blob: Blob;
  /** What the file is saved as — the API's name when it sent one. */
  readonly fileName: string;
}

const REPORT_EXPORT_PATH = '/v1/reports/dashboard/export';
const CSV_MEDIA_TYPE = 'text/csv;charset=utf-8';

export async function downloadDashboardExport(
  query: DashboardExportQuery,
  signal?: AbortSignal,
): Promise<DashboardExportFile> {
  if (typeof window === 'undefined') {
    throw new Error('The dashboard export must be fetched by the browser, not by the server.');
  }

  if (webEnv.useMockApi) {
    return mockExport(query);
  }

  const { section, ...metricsQuery } = query;
  const search = reportSearchParams(metricsQuery, section);

  const response = await fetch(`${webEnv.apiBaseUrl}${REPORT_EXPORT_PATH}?${search.toString()}`, {
    method: 'GET',
    credentials: 'include',
    // A report is a tenant's own numbers for a range the caller chose; the API
    // answers `private, no-store` for that reason and this asks for the same.
    cache: 'no-store',
    signal,
  });

  if (!response.ok) {
    throw await toApiRequestError(response);
  }

  return {
    blob: await response.blob(),
    fileName: fileNameFor(response.headers.get('content-disposition'), query),
  };
}

/**
 * Mock mode's answer, because this one call cannot reach the fixture transport:
 * everything else in `lib/api` runs on the Next process, and this runs in the
 * browser. `media-browser.ts` answers its own upload for the same reason.
 *
 * It goes through a server action rather than fabricating a file, so the bytes
 * come from the same mock aggregate the screen was rendered from — which is the
 * property a reviewer is checking when they open the downloaded file next to the
 * page, and the one a hand-written fixture would quietly fake.
 */
async function mockExport(query: DashboardExportQuery): Promise<DashboardExportFile> {
  const result = await exportDashboardCsvAction(query);

  if (result.status === 'error') {
    throw new Error(result.message);
  }

  return {
    blob: new Blob([result.data], { type: CSV_MEDIA_TYPE }),
    fileName: derivedFileName(query),
  };
}

/**
 * The API's `Content-Disposition` name, or the contract's own naming rule.
 *
 * The header is authoritative — deriving the name as a matter of course would be a
 * second implementation of a rule ADR 0010 (reporting dashboard and export)
 * decision 7 already fixes — but it is also a value that ends up as a filename on
 * somebody's disk, so it is accepted only in the shape the contract describes.
 * Anything else falls back rather than being sanitised into a different name: a
 * path separator or a control character in there is a bug on the API side, not
 * something to correct quietly.
 */
function fileNameFor(header: string | null, query: DashboardExportQuery): string {
  const quoted = /filename="([^"]*)"/.exec(header ?? '');
  const candidate = quoted?.[1] ?? '';

  return SAFE_FILE_NAME.test(candidate) ? candidate : derivedFileName(query);
}

const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+\.csv$/;

/**
 * `report-<section>-<from>-<to>.csv`, per ADR 0010 (reporting dashboard and
 * export) decision 7.
 */
export function derivedFileName(query: DashboardExportQuery): string {
  return `report-${query.section}-${query.from}-${query.to}.csv`;
}
