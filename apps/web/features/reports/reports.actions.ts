'use server';

import { DashboardExportQuerySchema } from '@whatsappcrm/contracts';
import { getMockDashboardExportCsv } from '@/lib/api/reports';
import { runAction } from '@/lib/actions/run-action';
import type { ActionResult } from '@/lib/actions/result';

/**
 * The mock-mode half of the export (TAR-431).
 *
 * The real export is a browser fetch — see `lib/api/reports-browser.ts` for why —
 * and this exists only because mock mode's fixtures live on the Next process,
 * where the browser cannot reach them. It is the same shape every other action
 * has: assert the permission, validate against the *contract's* own schema, and
 * return a failure as a value rather than a throw.
 *
 * Asserting `report:read` here is defence in depth rather than the boundary: a
 * server action is a public endpoint, and the API refuses the same call
 * regardless.
 */
export async function exportDashboardCsvAction(input: unknown): Promise<ActionResult<string>> {
  return runAction({
    permission: 'report:read',
    parser: DashboardExportQuerySchema,
    input,
    perform: getMockDashboardExportCsv,
    // Nothing is written, and the page behind the download must not re-render:
    // revalidating here would rebuild the dashboard under the supervisor while
    // their file is still being saved.
    revalidate: null,
    label: 'Dashboard export',
  });
}
