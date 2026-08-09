import { ApiErrorSchema } from '@whatsappcrm/contracts';

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api';

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

/**
 * The single entry point for talking to the API. Frontend stories call this
 * rather than `fetch`, so auth headers, tenant routing and error handling stay
 * in one place. TAR-39 fixes the contract this speaks.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    throw await toApiRequestError(response);
  }

  return (await response.json()) as T;
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
