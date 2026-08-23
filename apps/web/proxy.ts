import { NextResponse, type NextRequest } from 'next/server';
import {
  EDGE_AUTH_HEADER,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_SECURE,
  TENANT_HOST_HEADER,
} from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { routes } from '@/lib/routes';
import { REQUEST_PATH_HEADER, isPublicPath } from '@/lib/session/session-paths';
import {
  PLATFORM_ADMIN_COOKIE_NAME,
  isAdminPath,
  isAdminPublicPath,
} from '@/lib/admin/admin-paths';

/**
 * The route guard's first half: an **optimistic** check that turns a visitor with
 * no session cookie away from a protected route before the page renders at all.
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
 * It also names the tenant on the **browser's** calls to the API. Those do not go
 * through `lib/api/http.ts`; they are proxied to the API origin by
 * `next.config.mjs`, and that proxy replaces `Host` with the destination's. This
 * is the only place in the request's life where the tenant host is still known,
 * so the same header pair the server-side transport sends is injected here.
 *
 * ⚠️ Next 16 renamed this file convention from `middleware` to `proxy`. Also note
 * that a Server Function is a POST to the route it lives on, so the matcher below
 * covers actions too — but a matcher is never a substitute for the assertion each
 * action makes itself.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  // Before the guard, and returning immediately: an API call must never be
  // answered with a redirect to an HTML sign-in page, which would turn a clean
  // 401 into a parse failure in the caller. The API authenticates these itself.
  if (isApiPath(pathname)) {
    return NextResponse.next({ request: { headers: withTenantRouting(request) } });
  }

  // Published to the server render on every matched request, protected or not:
  // a page that resolves a session needs to know where the user was going, and
  // there is no `usePathname` on the server.
  const response = NextResponse.next({
    request: { headers: withRequestPath(request.headers, `${pathname}${search}`) },
  });

  /*
   * The platform-operator console, before the tenant guard below and never
   * falling through to it (TAR-804).
   *
   * Two credentials exist in this app and they authenticate different things: a
   * tenant session identifies a *user inside one tenant*, and
   * `PLATFORM_ADMIN_TOKEN` identifies nobody at all — it is the platform's own
   * control plane, which has to work before the first tenant exists. Letting
   * `/admin` reach the tenant guard would send an operator to a tenant's sign-in
   * screen to solve a problem signing in cannot solve, and a *signed-in* tenant
   * user straight through to the operator console's shell.
   *
   * `enableRoleStub` is deliberately not honoured here either. It is TAR-35's
   * interim switch for demonstrating the three tenant roles, and no stub of a
   * tenant role stands in for a platform credential.
   */
  if (isAdminPath(pathname)) {
    return isAdminPublicPath(pathname) || hasPlatformAdminCookie(request)
      ? response
      : NextResponse.redirect(
          new URL(routes.adminSignIn({ redirectTo: `${pathname}${search}` }), request.nextUrl),
        );
  }

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
 * One spelling, unlike the session cookie's two: this console sets the cookie
 * itself, so there is no server-side flag it cannot read to guess the name from.
 *
 * Presence only, on the same reasoning as the session check above — the proxy
 * runs on every request including prefetches, and the authoritative check is the
 * one `lib/api/admin.ts` makes when it calls the API with the value.
 */
function hasPlatformAdminCookie(request: NextRequest): boolean {
  return request.cookies.has(PLATFORM_ADMIN_COOKIE_NAME);
}

/**
 * What `next.config.mjs` rewrites to the API origin.
 *
 * The rewrite's `/api/:path*` matches **zero** segments too, so bare `/api` is
 * proxied as well — a prefix test on `/api/` alone would miss it and hand that
 * one request to the guard, which answers a 307 to `/login`, the exact outcome
 * the early return exists to prevent. Nothing is mounted there today; the point
 * is that the two must describe the same set.
 */
const API_PATH = '/api';
const API_PATH_PREFIX = `${API_PATH}/`;

function isApiPath(pathname: string): boolean {
  return pathname === API_PATH || pathname.startsWith(API_PATH_PREFIX);
}

/**
 * The tenant, and the proof it came from us.
 *
 * Both are deleted first and then `set`, never appended: a caller that sent
 * either header itself must not be able to name the tenant its request resolves
 * to, and the incoming `Host` is the only thing here that a browser cannot forge
 * past the edge. The delete matters even when nothing is written afterwards —
 * otherwise a browser-supplied pair would travel on untouched.
 *
 * The names are private (`x-edge-host`, not `x-forwarded-host`) because the hop
 * from here to the API leaves Render and re-enters through proxies that populate
 * `x-forwarded-*` as a matter of course; a standard name is one an intermediary
 * is entitled to rewrite. Both come from `@whatsappcrm/contracts`, so this and
 * the guard cannot drift (TAR-148).
 *
 * With no secret configured the pair is dropped rather than sent unproven — the
 * API would refuse a host it cannot attribute anyway, and sending a host with no
 * proof only invites a guard that is tempted to trust it.
 */
function withTenantRouting(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  const host = request.headers.get('host');

  headers.delete(TENANT_HOST_HEADER);
  headers.delete(EDGE_AUTH_HEADER);

  if (host === null || host === '' || webEnv.trustedProxySecret === null) {
    return headers;
  }

  headers.set(TENANT_HOST_HEADER, host);
  headers.set(EDGE_AUTH_HEADER, webEnv.trustedProxySecret);

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
   * Everything except Next's own asset routes and any request for a file.
   *
   * `/api/*` used to be excluded here, because `next.config.mjs` rewrites it
   * straight to the API and redirecting an XHR to an HTML sign-in page would turn
   * a clean 401 into a parse failure in the caller. It is matched now — that
   * rewrite is the last point at which the tenant host is still known, so the
   * headers have to be attached here — and the guard is skipped for it instead,
   * in the first branch of `proxy`. What is preserved is "an API call is never
   * answered with a redirect", not "the proxy never sees an API call".
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)'],
};
