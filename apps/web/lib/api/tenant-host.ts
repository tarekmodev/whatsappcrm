import 'server-only';

import { headers } from 'next/headers';

/**
 * Names the tenant on a server-side call to the API.
 *
 * `HostTenantGuard` resolves the tenant from the host the request arrived on
 * (`apps/api/src/tenancy/host-tenant.guard.ts`), and ADR 0005's sequence diagram
 * assumes a "same-origin proxy, Host preserved". Neither hop actually preserves
 * it, and neither can be made to:
 *
 *   - **Server-side rendering and server actions** run on the Next process and
 *     call the API's absolute origin, so `Host` is that origin. Setting it back
 *     is not possible: Node's `fetch` (undici) silently drops a `Host` header
 *     supplied in `RequestInit`, because the fetch specification lists it as a
 *     forbidden request header. It is discarded without an error, which is why
 *     the obvious one-line fix looks like it works and does not.
 *   - **The browser** talks to the same-origin `/api` path that `next.config.mjs`
 *     rewrites to the API host, and Next's rewrite proxy constructs its
 *     `ProxyServer` with `changeOrigin: true`
 *     (`next/dist/server/lib/router-utils/proxy-request.js`), which overwrites
 *     `Host` with the destination. It is hard-coded, not configurable. That hop
 *     does set `x-forwarded-host` to the original host.
 *
 * So `x-forwarded-host` is the only header that survives both paths, and this
 * makes the server-side path carry what the browser's path already carries.
 *
 * ⚠️ This half is inert on its own. The API resolves the tenant from `Host` with
 * Express `trust proxy` deliberately unset, so it ignores this header until that
 * decision is revisited — see TAR-64. Sending it is safe in the meantime: an
 * ignored header changes nothing.
 *
 * **The host this process was reached on, never the caller's claim about it.**
 * An incoming `x-forwarded-host` is deliberately *not* preferred over `host`: a
 * client can send that header, and honouring it would let anyone who can reach
 * the console choose which tenant their request resolves to — the exact
 * substitution `HostTenantGuard` exists to prevent. A hop in front of Next that
 * rewrites `Host` therefore needs the same deliberate, reviewed change on this
 * side as `trust proxy` does on the API's.
 */

export const TENANT_HOST_HEADER = 'x-forwarded-host';

export async function tenantHostHeaders(): Promise<Record<string, string>> {
  const host = (await headers()).get('host');

  // No host to forward. The API answers `tenant_not_found`, which is the same
  // answer it gives for a hostname no tenant is served at — the console never
  // decides that question itself.
  return host === null || host === '' ? {} : { [TENANT_HOST_HEADER]: host };
}
