import { webEnv } from '@/lib/config/env';
import { handleMockRequest } from '@/lib/api/mock/handlers';
import { toApiRequestError } from '@/lib/api/error';
import { tenantRoutingHeaders } from '@/lib/api/tenant-host';
import { roleStubHeaders } from '@/lib/session/role-stub-request';
import { isMultipartBody, type ApiRequest } from '@/lib/api/request';

/**
 * The server-side entry point for talking to the API. Every resource module goes
 * through `apiRequest`, so error mapping, the mock/real switch and the tenant the
 * call is for live in exactly one place.
 *
 * The mock branch is a *transport*, not a per-feature fake: resource modules are
 * byte-identical in both modes, so wiring TAR-81's real endpoints is one flag.
 *
 * The three calls that must be made by the browser rather than by this process
 * go through `lib/api/auth-browser.ts` instead, which explains why.
 */

export { ApiRequestError } from '@/lib/api/error';
export { HTTP_METHODS, isMultipartBody, type ApiRequest, type HttpMethod } from '@/lib/api/request';

export async function apiRequest(request: ApiRequest): Promise<unknown> {
  if (webEnv.useMockApi) {
    return handleMockRequest(request);
  }

  const isMultipart = isMultipartBody(request.body);

  const response = await fetch(`${resolveBaseUrl()}${request.path}`, {
    method: request.method,
    credentials: 'include',
    // Role and tenant scoping are decided per request; a cached list would
    // survive a role change and show one principal another one's data.
    cache: 'no-store',
    // The tenant goes on every server-side call, not just the authenticated
    // ones: sign-in and password reset are unauthenticated *and* tenant-scoped,
    // so they need it too. Here rather than per resource module, so a new call
    // site cannot forget it — the same reason the cookie has one home.
    //
    // Last, so it wins. Every other header is a default a caller may replace;
    // this pair decides which tenant's data comes back, and a call site that
    // could set it from anything request-derived is the tenant spoof this
    // whole mechanism exists to prevent. `proxy.ts` takes the same position on
    // the browser path. A call that genuinely needs to name another tenant
    // wants an explicit function, not a header it happens to be able to set.
    //
    // The interim role stub rides alongside for the same reason it is here and
    // not in a resource module: it has to be on *every* server-side call or the
    // switcher moves the chrome and nothing else (TAR-366). It is `{}` unless
    // the stub is explicitly on, so the real-session path is untouched.
    headers: {
      // Omitted for multipart: `fetch` has to write it itself so the boundary in
      // the header matches the one in the body. Setting it by hand is how a
      // multipart upload arrives at the server as an unparseable blob.
      ...(isMultipart ? {} : { 'content-type': 'application/json' }),
      ...request.headers,
      ...(await roleStubHeaders()),
      ...(await tenantRoutingHeaders()),
    },
    body: toRequestBody(request.body, isMultipart),
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

/** `FormData` goes through untouched; everything else is serialised as JSON. */
function toRequestBody(body: unknown, isMultipart: boolean): BodyInit | undefined {
  if (body === undefined) {
    return undefined;
  }

  return isMultipart ? (body as FormData) : JSON.stringify(body);
}

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
