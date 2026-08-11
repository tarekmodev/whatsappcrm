import { ApiErrorSchema } from '@whatsappcrm/contracts';

/**
 * The one error type every API call in the app throws, and the one place a
 * non-2xx response is turned into it.
 *
 * Split out of `http.ts` because that module is `server-only` — it reaches the
 * fixture transport — while the auth screens have to call the API from the
 * *browser*, so that the session `Set-Cookie` lands in the user's browser rather
 * than in a server-side fetch nobody can use. Both transports throw this, so the
 * frontend still has exactly one error type to catch.
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

export async function toApiRequestError(response: Response): Promise<ApiRequestError> {
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
