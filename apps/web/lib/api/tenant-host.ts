import 'server-only';

import { headers } from 'next/headers';
import { EDGE_AUTH_HEADER, TENANT_HOST_HEADER } from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';

/**
 * Names the tenant on a server-side call to the API, and proves the naming.
 *
 * `HostTenantGuard` resolves which tenant a request is for from the host, and
 * that is the whole of the tenant-routing decision
 * (`apps/api/src/tenancy/host-tenant.guard.ts`). A call that does not carry the
 * caller's host resolves no tenant and is answered `tenant_not_found` — so every
 * server-rendered page under `app/(app)` fails, not just the ones that read data.
 *
 * ## Why a forwarded host, and not `Host`
 *
 * `Host` cannot carry the tenant in any deployed environment, and each of these
 * was verified against the versions in this repository rather than assumed:
 *
 *   - **Render routes by `Host` at its edge.** A request only reaches the API
 *     service if `Host` names that service, and a tenant's custom domain (TAR-29)
 *     is attached to the *web* service. `request.hostname` inside the API can
 *     therefore never be a tenant hostname in production.
 *   - **Server-side.** `fetch` derives `Host` from the URL's authority and drops
 *     any `Host` the caller supplies — it is a forbidden header name. Node 22
 *     ignores it silently, so the wrong host is not even an error.
 *   - **Browser-side.** Next's rewrite proxy hardcodes `changeOrigin: true`
 *     (`next/dist/server/lib/router-utils/proxy-request.js`), replacing `Host`
 *     with the destination's. `rewrites()` exposes no option that changes it.
 *
 * ## Why the secret
 *
 * A forwarded host is a host the caller chose, which is the tenant spoof
 * `HostTenantGuard`'s own docstring warns about. So the pair travels together:
 * the API honours `x-forwarded-host` only from a request that also presents the
 * secret both tiers hold, and otherwise falls back to `Host` exactly as it does
 * today — never to the forwarded value. See the trust-boundary decision on
 * TAR-64 for the options weighed and the residual risk accepted.
 *
 * The browser's own calls do not come through here — they are proxied by
 * `next.config.mjs` — so `proxy.ts` injects the same pair on that path.
 */

export async function tenantRoutingHeaders(): Promise<Record<string, string>> {
  const host = (await headers()).get('host');

  if (host === null || host === '') {
    // Fail loudly rather than send a call the API can only answer
    // `tenant_not_found`: a request with no host is a proxy or runtime that is
    // misconfigured, and a 404 three layers down is an unrecognisable symptom.
    throw new Error('The incoming request carries no Host, so no tenant can be named to the API.');
  }

  if (webEnv.trustedProxySecret === null) {
    // Configured everywhere the API is reached over HTTP. Absent, the API falls
    // back to `Host`, resolves nothing and answers `tenant_not_found` on every
    // tenant route — total and loud rather than a silent cross-tenant read, but
    // still an outage, so a deployed environment refuses to serve rather than
    // discover it one request at a time.
    if (webEnv.isProduction) {
      throw new Error(
        'TRUSTED_PROXY_SECRET is not configured, so the API cannot be told which tenant ' +
          'a server-side call is for. Set it to the same value the API holds.',
      );
    }

    // Neither header, rather than a host with nothing to vouch for it. The API
    // would refuse a host it cannot attribute anyway, and shipping one anyway
    // only invites a guard that is tempted to trust it. `proxy.ts` drops the
    // pair for the same reason on the browser path.
    return {};
  }

  return {
    [TENANT_HOST_HEADER]: host,
    [EDGE_AUTH_HEADER]: webEnv.trustedProxySecret,
  };
}
