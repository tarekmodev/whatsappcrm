import { webEnv } from '@/lib/config/env';
import { toApiRequestError } from '@/lib/api/error';
import type { ApiRequest } from '@/lib/api/request';

/**
 * The browser-side transport, used by the flows that must run in the user's own
 * browser rather than on the server.
 *
 * That is a short list, and it is short for one reason: **the session cookie**.
 * Sign-in and invite acceptance answer with `Set-Cookie`, and a cookie set on a
 * server-side fetch belongs to the server, not to the person signing in. Sending
 * these two from the browser — to the same-origin `/api` path that
 * `next.config.mjs` rewrites to the API host — is what makes the cookie
 * first-party to whatever host the tenant is on, with no token ever passing
 * through frontend code (TAR-39, Decision 3; TAR-53).
 *
 * Everything else stays on `lib/api/http.ts`, which can reach the fixture
 * transport and forward the principal's cookie server-side.
 */
export async function browserApiRequest(request: ApiRequest): Promise<unknown> {
  if (typeof window === 'undefined') {
    // A server-side call here would set the cookie on the wrong machine, and the
    // failure would look like "login silently does nothing". Fail loudly instead.
    throw new Error('browserApiRequest must run in the browser; use apiRequest on the server.');
  }

  const response = await fetch(`${webEnv.apiBaseUrl}${request.path}`, {
    method: request.method,
    // Same-origin already, but explicit: the response's `Set-Cookie` is the
    // entire point of these calls.
    credentials: 'include',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...request.headers },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });

  if (!response.ok) {
    throw await toApiRequestError(response);
  }

  if (response.status === HTTP_NO_CONTENT) {
    return null;
  }

  return (await response.json()) as unknown;
}

const HTTP_NO_CONTENT = 204;
