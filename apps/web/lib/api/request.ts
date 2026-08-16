/**
 * The request shape both transports take. Lives apart from `http.ts` because
 * that module is `server-only` and the browser transport needs the same type.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ApiRequest {
  readonly method: HttpMethod;
  /** Path below the API base, e.g. `/v1/users`. Query included, already encoded. */
  readonly path: string;
  /**
   * JSON by default. A `FormData` body is sent as multipart instead — the
   * transport writes neither the content type nor the boundary in that case,
   * because only `fetch` can make the two agree.
   *
   * Multipart is deliberately rare: the only uploads that take this path are the
   * branding logo and favicon, which are capped at 512 KB and 64 KB, so buffering
   * one in this process costs nothing. WhatsApp media is 100 MB and goes straight
   * from the browser to the API (`media-browser.ts`) for exactly that reason.
   */
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** True when the body must be sent as multipart rather than serialised as JSON. */
export function isMultipartBody(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}
