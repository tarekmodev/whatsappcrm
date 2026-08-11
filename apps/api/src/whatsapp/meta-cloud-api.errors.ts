/**
 * How a Graph API call fails, in the four shapes a caller acts on differently.
 *
 * Meta reports everything as `{ error: { code, error_subcode, message, type,
 * fbtrace_id } }` with an HTTP status attached, and squashing that into one
 * error type would make the two decisions a caller has to take impossible:
 * *should this be retried*, and *is this the tenant's problem or ours*.
 *
 * None of these ever carries the access token, the request body, or a message
 * body. `fbtrace_id` is carried because it is what a support conversation with
 * Meta is conducted in, and it identifies their log line rather than our data.
 */

/** Meta's own description of a failure, as much of it as is safe to keep. */
export interface MetaErrorDetail {
  /** Meta's numeric error code, e.g. 131047 (re-engagement required). */
  code: number | null;
  /** Meta's sub-code, where it sends one. */
  subcode: number | null;
  /** Meta's human-readable message. Never a message body — this is about the request, not its content. */
  message: string;
  /** Meta's trace id. The handle a support ticket with Meta is opened on. */
  traceId: string | null;
}

abstract class MetaCloudApiError extends Error {
  protected constructor(
    message: string,
    readonly status: number,
    readonly detail: MetaErrorDetail | null,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * 401/403, or one of Meta's OAuth error codes. The stored access token is
 * expired, revoked, or lacks the permission for this call.
 *
 * **Never retried.** Retrying a rejected credential burns rate limit and, on
 * repeat, is what gets an app flagged. The tenant has to re-connect the WABA.
 */
export class MetaAuthenticationError extends MetaCloudApiError {
  constructor(status: number, detail: MetaErrorDetail | null) {
    super(
      'Meta rejected the access token for this WhatsApp business account. It has expired, been ' +
        'revoked, or lacks the required permission; the business account must be re-connected.',
      status,
      detail,
    );
  }
}

/**
 * 429, or Meta's throttling codes (4, 80007, 130429, 131048). The call is
 * legitimate and should be retried later with backoff — never immediately, and
 * never in the request path.
 */
export class MetaRateLimitedError extends MetaCloudApiError {
  constructor(
    status: number,
    detail: MetaErrorDetail | null,
    /** Seconds Meta asked us to wait, when it says so. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(
      'Meta is throttling this WhatsApp business account. The call was not performed and should be ' +
        'retried with backoff.',
      status,
      detail,
    );
  }
}

/**
 * Meta answered, and refused. A malformed request, a template that is not
 * approved, a recipient outside the service window — the call will fail the same
 * way if it is repeated, so it is not retried.
 */
export class MetaRequestRejectedError extends MetaCloudApiError {
  constructor(status: number, detail: MetaErrorDetail | null) {
    super(`Meta rejected the request: ${detail?.message ?? 'no reason given'}`, status, detail);
  }
}

/**
 * Meta did not answer usefully: a timeout, a connection failure, a 5xx, or a
 * body that is not the JSON the API documents. Transient by assumption, so this
 * is the one a retry policy acts on.
 *
 * `reason` is a short classification rather than the underlying error string: an
 * undici error quotes the request URL, and the URL carries the phone number id.
 */
export class MetaUnavailableError extends MetaCloudApiError {
  constructor(
    status: number,
    detail: MetaErrorDetail | null,
    readonly reason: string,
  ) {
    super(
      `Meta's Graph API did not complete the request (${reason}). This is transient and safe to retry.`,
      status,
      detail,
    );
  }
}

export { MetaCloudApiError };
