import { ApiErrorSchema } from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { handleMockRequest } from '@/lib/api/mock/handlers';

/**
 * The single entry point for talking to the API. Every resource module goes
 * through `apiRequest`, so auth headers, error mapping and the mock/real switch
 * live in exactly one place.
 *
 * The mock branch is a *transport*, not a per-feature fake: resource modules are
 * byte-identical in both modes, so wiring TAR-81's real endpoints is one flag.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ApiRequest {
  readonly method: HttpMethod;
  /** Path below the API base, e.g. `/v1/users`. Query included, already encoded. */
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * Thrown for every non-2xx API response. Because the API guarantees one error
 * envelope, the whole frontend has exactly one error type to catch.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

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

async function toApiRequestError(response: Response): Promise<ApiRequestError> {
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    // A response that is not JSON at all means the failure happened before the
    // API's error filter ran — a proxy 502, say. Do not pretend it was our shape.
    return new ApiRequestError(response.status, 'upstream_error', response.statusText, null);
  }

  const parsed = ApiErrorSchema.safeParse(body);

  if (!parsed.success) {
    return new ApiRequestError(response.status, 'malformed_error', response.statusText, null);
  }

  const { code, message, requestId } = parsed.data.error;

  return new ApiRequestError(response.status, code, message, requestId);
}
