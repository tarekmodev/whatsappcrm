import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_NAME_SECURE } from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { routes } from '@/lib/routes';
import {
  EDGE_AUTH_HEADER,
  EDGE_HOST_HEADER,
  isApiProxyPath,
  tenantForwardingHeaders,
} from '@/lib/api/tenant-forwarding';
import { REQUEST_PATH_HEADER, isPublicPath } from '@/lib/session/session-paths';

/**
 * Two jobs, both of which have to happen before a request is routed and neither
 * of which any other layer can do.
 *
 * The first is the browser's path to the API: `/api/*` is rewritten straight to
 * the API origin by `next.config.mjs`, and `rewrites()` cannot add a request
 * header — so the headers that name the tenant are added here, or nowhere. See
 * `lib/api/tenant-forwarding.ts`.
 *
 * The second is the route guard's first half: an **optimistic** check that turns
 * a visitor with no session cookie away from a protected route before the page
 * renders at all.
 *
 * Two halves, on purpose (Next's own authentication guidance, and TAR-53's
 * session model):
 *
 *   1. Here — cookie *presence* only. No API call: the proxy runs on every
 *      request including prefetches, and a round-trip per prefetch would be a
 *      self-inflicted load test. Presence proves nothing about validity, which is
 *      why this is not the gate.
 *   2. `lib/session/session.ts` — the authoritative check. It asks the API who
 *      the caller is and redirects when the answer is "nobody", so a cookie that
 *      is expired, revoked, or replayed against another tenant's host is caught
 *      even though it looked fine here.
 *
 * What this half actually buys is the common case: a signed-out visitor opening
 * a deep link gets a redirect instead of a render that fetches, fails and
 * redirects anyway.
 *
 * ⚠️ Next 16 renamed this file convention from `middleware` to `proxy`. Also note
 * that a Server Function is a POST to the route it lives on, so the matcher below
 * covers actions too — but a matcher is never a substitute for the assertion each
 * action makes itself.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  // The browser's API path, and the only branch that returns before the session
  // handling below. Two reasons it has to be first: it is not a page, so the
  // request-path header means nothing to it; and redirecting an XHR to an HTML
  // sign-in page would turn the API's clean 401 into a parse failure in the
  // caller — the exclusion the matcher used to express, now expressed here.
  if (isApiProxyPath(pathname)) {
    return NextResponse.next({ request: { headers: withTenantForwarding(request.headers) } });
  }

  // Published to the server render on every matched request, protected or not:
  // a page that resolves a session needs to know where the user was going, and
  // there is no `usePathname` on the server.
  const response = NextResponse.next({
    request: { headers: withRequestPath(request.headers, `${pathname}${search}`) },
  });

  if (isPublicPath(pathname) || hasSessionCookie(request) || webEnv.enableRoleStub) {
    return response;
  }

  // `?next=` so sign-in returns them to the link they followed rather than the
  // inbox. It is re-narrowed on the way out by `parseRedirectPath`; nothing
  // trusts it just because this wrote it.
  return NextResponse.redirect(
    new URL(routes.login({ redirectTo: `${pathname}${search}` }), request.nextUrl),
  );
}

/**
 * Both cookie spellings, for the reason `session-cookie.ts` documents: the API
 * names the cookie from its own `SESSION_COOKIE_SECURE` flag, which this process
 * cannot read.
 */
function hasSessionCookie(request: NextRequest): boolean {
  return [SESSION_COOKIE_NAME_SECURE, SESSION_COOKIE_NAME].some((name) =>
    request.cookies.has(name),
  );
}

/**
 * The tenant headers for a browser call, on their way to the rewrite.
 *
 * Both are cleared before either is written. A browser can send whatever headers
 * it likes, and `x-edge-auth` is the one credential that makes `x-edge-host`
 * believable — so a value that arrived from outside must never survive to the
 * API, whether or not this tier has a secret of its own to replace it with. The
 * host likewise comes from the connection, never from what the caller claimed.
 *
 * Nothing here touches `x-forwarded-host`: the API stopped reading it when the
 * pair moved to private names (TAR-148), and Next's own rewrite proxy sets it
 * from the connection on the way out regardless.
 */
function withTenantForwarding(incoming: Headers): Headers {
  const headers = new Headers(incoming);

  headers.delete(EDGE_HOST_HEADER);
  headers.delete(EDGE_AUTH_HEADER);

  const host = incoming.get('host');

  if (host === null || host === '') {
    // Nothing to name the tenant with. Left to the API, which answers
    // `tenant_not_found` — the same outcome as before this branch existed, and
    // not one worth failing a request the guard would refuse anyway.
    return headers;
  }

  for (const [name, value] of Object.entries(tenantForwardingHeaders(host))) {
    headers.set(name, value);
  }

  return headers;
}

function withRequestPath(incoming: Headers, path: string): Headers {
  const headers = new Headers(incoming);

  // Always `set`, never `append`: a client that sent this header itself must not
  // be able to choose the path the login redirect returns them to.
  headers.set(REQUEST_PATH_HEADER, path);

  return headers;
}

export const config = {
  /**
   * Next reads this statically at build time, so every entry has to be a literal
   * — `API_PROXY_PATH_PREFIX` cannot be interpolated in, and the two must be
   * changed together.
   *
   *   1. The API proxy path. Matched so the tenant headers can be added to it;
   *      the redirect branch still never runs for it, so an XHR still never
   *      receives an HTML sign-in page.
   *   2. Everything else except Next's own asset routes and any request for a
   *      file. `api/` stays excluded here so the two entries cannot both match
   *      one request.
   */
  matcher: ['/api/:path*', '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)'],
};
