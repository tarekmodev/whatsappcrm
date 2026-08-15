import 'server-only';

import type { TenantLifecycleResponse, TenantResponse } from '@whatsappcrm/contracts';
import { getTenant, getTenantLifecycle } from '@/lib/api/tenant';

/**
 * Server-side reads for the workspace settings surface.
 *
 * `lifecycle` is `null` when the caller may not read it. The page is two
 * surfaces behind two permissions — the profile needs none beyond a session,
 * the plan panel needs `tenant:settings` — and a principal holding one but not
 * the other must get the half they are allowed rather than a 403 for the whole
 * page. Deciding that here, from the checker the session already resolved,
 * keeps the request from being made at all: asking and catching the refusal
 * would spend a round-trip to learn something the console already knows.
 */

export interface WorkspaceData {
  readonly tenant: TenantResponse;
  readonly lifecycle: TenantLifecycleResponse | null;
}

export async function loadWorkspace({
  canReadLifecycle,
}: {
  canReadLifecycle: boolean;
}): Promise<WorkspaceData> {
  // Independent requests: awaiting them in sequence would double the page's
  // TTFB for no reason.
  const [tenant, lifecycle] = await Promise.all([
    getTenant(),
    canReadLifecycle ? getTenantLifecycle() : null,
  ]);

  return { tenant, lifecycle };
}
