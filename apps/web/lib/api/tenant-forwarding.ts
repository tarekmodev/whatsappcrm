import { webEnv } from '@/lib/config/env';

/**
 * The seam between this console and the API: which headers name the tenant a
 * request is for, and which paths the browser reaches the API through.
 *
 * `HostTenantGuard` resolves the tenant from the host a request arrived on, and
 * that is the whole of the tenant-routing decision
 * (`apps/api/src/tenancy/host-tenant.guard.ts`). Neither of the two paths out of
 * this app preserves that host on its own, so both have to say it explicitly —
 * and they must say exactly the same thing, which is why the pair is built here
 * once rather than at each call site:
 *
 *   - **Server-rendered calls** go through `lib/api/http.ts`, which spreads
 *     these onto every `fetch`. See `lib/api/tenant-host.ts` for why `Host`
 *     itself cannot be used.
 *   - **Browser calls** go to the same-origin `/api/*` path that
 *     `next.config.mjs` rewrites to the API origin. `rewrites()` cannot add a
 *     request header, so `proxy.ts` adds them before the rewrite runs.
 *
 * ## Why a secret rides along
 *
 * A forwarded host is a header, and a header is something any caller that can
 * reach the API directly may write — which is exactly the tenant-spoofing hole
 * `HostTenantGuard`'s own docstring warns about. So the API trusts
 * `x-forwarded-host` only when the request also presents `x-edge-auth` matching
 * its `TRUSTED_PROXY_SECRET`, and otherwise reads `Host` as it does today. The
 * secret is what distinguishes "this came from our web tier" from "somebody sent
 * us a header" (TAR-64, and TAR-149 for this half).
 *
 * Deliberately **not** `server-only`, for the same reason
 * `lib/session/session-paths.ts` is not: `proxy.ts` and the server-side
 * transport both import it, and one module is the only way the two paths cannot
 * drift into disagreeing about what they send. It carries no secret literal of
 * its own — the value comes from `webEnv`, which reads a variable Next never
 * inlines into the browser bundle.
 */

/**
 * Standard, and the name Next's own rewrite proxy already uses on the browser
 * path (`next/dist/server/lib/router-utils/proxy-request.js`).
 */
export const FORWARDED_HOST_HEADER = 'x-forwarded-host';

/**
 * Proves the forwarded host above came from this tier. Matched against the API's
 * `TRUSTED_PROXY_SECRET` with a timing-safe comparison; a missing or wrong value
 * degrades to reading `Host`, never to trusting the forwarded one.
 */
export const EDGE_AUTH_HEADER = 'x-edge-auth';

/**
 * The same-origin path the browser reaches the API through. It is a fixed
 * contract shared by three places that cannot import each other — the rewrite in
 * `next.config.mjs`, the matcher in `proxy.ts` (Next reads that statically, so it
 * has to be a literal), and this constant. Changing one means changing all three.
 */
export const API_PROXY_PATH_PREFIX = '/api';

export function isApiProxyPath(pathname: string): boolean {
  return pathname === API_PROXY_PATH_PREFIX || pathname.startsWith(`${API_PROXY_PATH_PREFIX}/`);
}

/**
 * The headers that name `host` as the tenant of an outgoing API call.
 *
 * With no secret configured the pair collapses to the host alone: that is the
 * local-development and docker-compose case, where the API still reads `Host`
 * and nothing has changed. Sending `x-edge-auth` empty instead would be a value
 * the guard has to special-case, so it is omitted rather than blanked.
 */
export function tenantForwardingHeaders(host: string): Record<string, string> {
  const { trustedProxySecret } = webEnv;

  if (trustedProxySecret === null) {
    return { [FORWARDED_HOST_HEADER]: host };
  }

  return {
    [FORWARDED_HOST_HEADER]: host,
    [EDGE_AUTH_HEADER]: trustedProxySecret,
  };
}
