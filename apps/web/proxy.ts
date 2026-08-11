import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_NAME_SECURE } from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { routes } from '@/lib/routes';
import { REQUEST_PATH_HEADER, isPublicPath } from '@/lib/session/session-paths';

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
 * ⚠️ Next 16 renamed this file convention from `middleware` to `proxy`. Also note
 * that a Server Function is a POST to the route it lives on, so the matcher below
 * covers actions too — but a matcher is never a substitute for the assertion each
 * action makes itself.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

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

function withRequestPath(incoming: Headers, path: string): Headers {
  const headers = new Headers(incoming);

  // Always `set`, never `append`: a client that sent this header itself must not
  // be able to choose the path the login redirect returns them to.
  headers.set(REQUEST_PATH_HEADER, path);

  return headers;
}

export const config = {
  /**
   * Everything except the API proxy path, Next's own asset routes and any request
   * for a file. `/api/*` is excluded because `next.config.mjs` rewrites it
   * straight to the API, which authenticates the request itself and answers 401 —
   * redirecting an XHR to an HTML sign-in page would turn a clean error into a
   * parse failure in the caller.
   */
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)'],
};
