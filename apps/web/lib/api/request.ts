/**
 * The request shape both transports take. Lives apart from `http.ts` because
 * that module is `server-only` and the browser transport needs the same type.
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
