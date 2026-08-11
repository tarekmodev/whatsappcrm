import { webEnv } from '@/lib/config/env';
import { handleMockRequest } from '@/lib/api/mock/handlers';
import { toApiRequestError } from '@/lib/api/error';
import type { ApiRequest } from '@/lib/api/request';

/**
 * The server-side entry point for talking to the API. Every resource module goes
 * through `apiRequest`, so error mapping and the mock/real switch live in exactly
 * one place.
 *
 * The mock branch is a *transport*, not a per-feature fake: resource modules are
 * byte-identical in both modes, so wiring TAR-81's real endpoints is one flag.
 *
 * The three calls that must be made by the browser rather than by this process
 * go through `lib/api/auth-browser.ts` instead, which explains why.
 */

export { ApiRequestError } from '@/lib/api/error';
export { HTTP_METHODS, type ApiRequest, type HttpMethod } from '@/lib/api/request';

export async function apiRequest(request: ApiRequest): Promise<unknown> {
  if (webEnv.useMockApi) {
    return handleMockRequest(request);
  }

  const response = await fetch(`${resolveBaseUrl()}${request.path}`, {
    method: request.method,
    credentials: 'include',
    // Role and tenant scoping are decided per request; a cached list would
    // survive a role change and show one principal another one's data.
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

/**
 * The browser talks to a same-origin path that `next.config.mjs` rewrites to the
 * API host, so the session cookie stays first-party under a white-label domain
 * (TAR-39, Decision 3). Server-side rendering has no origin to be relative to,
 * so it needs the absolute one.
 */
function resolveBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return webEnv.apiBaseUrl;
  }

  return webEnv.serverApiBaseUrl;
}
