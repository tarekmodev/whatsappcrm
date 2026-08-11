import 'server-only';

import { headers } from 'next/headers';
import { tenantForwardingHeaders } from '@/lib/api/tenant-forwarding';

/**
 * Names the tenant on a server-side call to the API.
 *
 * `HostTenantGuard` resolves which tenant a request is for from the host it
 * arrived on, and that is the whole of the tenant-routing decision
 * (`apps/api/src/tenancy/host-tenant.guard.ts`). A call that does not carry the
 * caller's host resolves no tenant and is answered `tenant_not_found` — so every
 * server-rendered page under `app/(app)` fails, not just the ones that read data.
 *
 * ## Why `x-forwarded-host` rather than `Host`
 *
 * `Host` cannot be set on either path, and both were verified against the
 * versions in this repository rather than assumed:
 *
 *   - **Server-side.** `fetch` derives `Host` from the URL's authority and drops
 *     any `Host` the caller supplies — it is a forbidden header name. Node 22's
 *     implementation ignores it silently, so the wrong host is not even an error.
 *   - **Browser-side.** `next.config.mjs` rewrites `/api/*` to the API origin, and
 *     Next's proxy hardcodes `changeOrigin: true`
 *     (`next/dist/server/lib/router-utils/proxy-request.js`). It overwrites `Host`
 *     with the destination's and puts the browser's own host in
 *     `x-forwarded-host`. `rewrites()` exposes no option that changes this.
 *
 * So the browser path already delivers the tenant host in `x-forwarded-host`, and
 * this makes the server path say the same thing in the same header. One header
 * carries the tenant on both, which is what lets the API read it in one place.
 *
 * What the header *pair* is, and why a secret rides alongside the host, lives in
 * `lib/api/tenant-forwarding.ts` — shared with `proxy.ts`, which sends the same
 * pair on the browser path. This module is only the server-side half: reading the
 * incoming host, which is the one thing `next/headers` is needed for and the one
 * thing the proxy gets from somewhere else.
 */

export {
  EDGE_AUTH_HEADER,
  FORWARDED_HOST_HEADER,
  tenantForwardingHeaders,
} from '@/lib/api/tenant-forwarding';

export async function tenantHostHeaders(): Promise<Record<string, string>> {
  const host = (await headers()).get('host');

  if (host === null || host === '') {
    // Fail loudly rather than send a call the API can only answer
    // `tenant_not_found`: a request with no host is a proxy or runtime that is
    // misconfigured, and a 404 three layers down is an unrecognisable symptom.
    throw new Error('The incoming request carries no Host, so no tenant can be named to the API.');
  }

  return tenantForwardingHeaders(host);
}
