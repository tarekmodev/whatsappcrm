import { NextResponse, type NextRequest } from 'next/server';
import { REQUEST_PATH_HEADER } from '@/lib/session/session-paths';
import { routes } from '~/lib/routes';
import { CREDENTIAL_COOKIE_NAMES, isCredentialPath } from '~/lib/credential-paths';

/**
 * The operator console's route guard: an **optimistic** check that turns a
 * request with no credential cookie away before the page renders at all.
 *
 * Two halves, the same split `apps/web` makes:
 *
 *   1. Here — cookie *presence* only. No API call: the proxy runs on every
 *      request including prefetches, and a round-trip per prefetch would be a
 *      self-inflicted load test. Presence proves nothing about validity, which is
 *      why this is not the gate.
 *   2. `lib/api/admin.ts` — the authoritative check. It sends the credential and
 *      raises `CredentialRefusedError` when the API rejects it, which every
 *      screen renders as a state rather than a redirect.
 *
 * What this half buys is the common case: an operator opening a deep link with no
 * credential gets a redirect instead of a render that fetches, fails and
 * redirects anyway.
 *
 * ⚠️ Next 16 renamed this file convention from `middleware` to `proxy`. A Server
 * Function is a POST to the route it lives on, so the matcher below covers
 * actions too — but a matcher is never a substitute for the assertion each action
 * makes itself.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  // Published to the server render on every request: a screen that redirects
  // needs to know where the operator was going, and there is no `usePathname` on
  // the server.
  const response = NextResponse.next({
    request: { headers: withRequestPath(request.headers, `${pathname}${search}`) },
  });

  if (isCredentialPath(pathname) || hasCredentialCookie(request)) {
    return response;
  }

  // `?next=` so the credential screen returns them to the link they followed. It
  // is re-narrowed on the way out by `parseRedirectPath`; nothing trusts it just
  // because this wrote it.
  return NextResponse.redirect(
    new URL(routes.credential({ redirectTo: `${pathname}${search}` }), request.nextUrl),
  );
}

function hasCredentialCookie(request: NextRequest): boolean {
  return CREDENTIAL_COOKIE_NAMES.some((name) => request.cookies.has(name));
}

function withRequestPath(incoming: Headers, path: string): Headers {
  const headers = new Headers(incoming);

  // Always `set`, never `append`: a client that sent this header itself must not
  // be able to choose the path the redirect returns them to.
  headers.set(REQUEST_PATH_HEADER, path);

  return headers;
}

export const config = {
  /** Everything except Next's own asset routes and any request for a file. */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)'],
};
