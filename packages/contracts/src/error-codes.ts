import { z } from 'zod';
import type { ApiError, ApiErrorDetail } from './error';

/**
 * The canonical error-code taxonomy. TAR-38 fixed the envelope shape in
 * `error.ts`; this file fixes the vocabulary that goes inside it.
 *
 * Codes are `snake_case`, stable forever, and never localised — the frontend
 * branches on `code` and renders its own copy from `message`.
 *
 * **Strict on write, lenient on read.** The API may only emit a code from this
 * list (enforced by the typed exception factory in `apps/api`), but
 * `ApiErrorSchema.code` stays a plain string so a browser running yesterday's
 * bundle does not hard-fail on a code shipped by today's API.
 */
export const API_ERROR_CODES = [
  // --- Authentication and tenancy -------------------------------------------
  /** No session, or the session cookie is expired/revoked. */
  'unauthenticated',
  /** Authenticated, but the role lacks the permission for this operation. */
  'forbidden',
  /**
   * The session's tenant does not match the tenant the request host resolves to.
   * Deliberately distinct from `forbidden`: it means a session is being replayed
   * against another tenant's domain, which is a security event worth alerting on.
   */
  'tenant_mismatch',
  /** The request host matches no tenant domain. */
  'tenant_not_found',
  /** Credentials rejected at login. Never distinguishes unknown user from bad password. */
  'invalid_credentials',
  /**
   * An invite or password-reset token is unknown, expired, already used, or
   * revoked (TAR-53). One code for both flows: the frontend branches identically
   * for all four cases — "this link no longer works, request a new one" — and
   * the taxonomy is deliberately small.
   *
   * `details` carries `{ kind: 'invite' | 'password_reset', reason: 'unknown' |
   * 'expired' | 'consumed' | 'revoked' }`. Exposing `reason` leaks nothing: the
   * tokens are 256 bits of uniform entropy, so anyone able to ask already holds
   * the token.
   *
   * Deliberately **not** `not_found`: the accept and reset screens must offer
   * "request a new link", which has to be distinguishable from a 404 page.
   */
  'token_invalid',

  // --- Request validity ------------------------------------------------------
  /** Body, query or params failed schema validation. Always carries `details`. */
  'validation_failed',
  /** Absent, or present in another tenant — the two are indistinguishable by design. */
  'not_found',
  /** Uniqueness or optimistic-concurrency conflict. */
  'conflict',
  /** An `Idempotency-Key` was replayed with a different request body. */
  'idempotency_key_reused',
  /**
   * The write would leave the tenant with no active admin — a demotion,
   * suspension or removal of the last one (TAR-79, delta 3). Distinct from
   * `conflict` because it is the one refusal a client can act on by naming a
   * replacement admin first, and because it is worth counting separately: a
   * tenant that reaches zero admins can only be recovered by platform support.
   */
  'last_admin_required',
  /**
   * A workflow names a tag, team or user that no longer exists, and the request
   * would arm it (TAR-27, 0009 decision 6).
   *
   * Distinct from `validation_failed` because the body is well-formed and the
   * caller changed nothing: what is wrong is a reference that was valid when the
   * workflow was written. The console's next action differs too — "pick a
   * replacement", not "fix your input" — and `details` names each broken
   * reference by its path in the definition. Flattened into `validation_failed`,
   * the builder would be left string-matching on `message`, which is the thing
   * `code` exists to prevent.
   */
  'workflow_reference_broken',
  /** Payload exceeds the documented size cap. */
  'payload_too_large',
  /** Too many requests for this tenant or principal in the current window. */
  'rate_limited',

  // --- Plan, billing and quota ----------------------------------------------
  /** The tenant's plan does not include this feature. */
  'feature_not_in_plan',
  /** A hard plan limit (seats, conversation allowance) would be exceeded. */
  'plan_limit_exceeded',
  /** The tenant's subscription is suspended or cancelled. */
  'subscription_inactive',

  // --- WhatsApp channel ------------------------------------------------------
  /** The 24-hour customer service window has closed; an approved template is required. */
  'whatsapp_window_expired',
  /** The named template is missing, unapproved, or its variables do not match. */
  'whatsapp_template_invalid',
  /** Meta rejected the send. `details` carries Meta's own code. */
  'whatsapp_send_failed',
  /**
   * Embedded Signup could not be completed into a connected WABA (TAR-161,
   * 0002 amendment 2). `details` carries a `WhatsAppSignupFailureReason`, and it
   * is the reason rather than the code that tells the console what to do next —
   * every one of them is "re-run the flow", except the one that is "call
   * support", and a single code could not carry that difference.
   *
   * Deliberately **not** `whatsapp_send_failed`: nothing was sent, and an
   * operator reading that in a log would go looking for a message. Deliberately
   * not `validation_failed` either — the body was well-formed; what failed was a
   * grant. Meta being throttled or down keeps its own codes (`rate_limited`,
   * `upstream_unavailable`), because those *are* retryable as-is.
   */
  'whatsapp_signup_failed',
  /** Webhook signature verification failed. Never returned to a browser. */
  'webhook_signature_invalid',

  // --- Infrastructure --------------------------------------------------------
  /** A dependency (Meta, the billing provider, the LLM) is unavailable. */
  'upstream_unavailable',
  /** Unhandled server fault. The message is always generic; detail stays in the log line. */
  'internal_error',
] as const;

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * The single mapping from error code to HTTP status. Handlers throw a code and
 * this decides the status, so the same condition can never answer 403 on one
 * endpoint and 404 on another.
 */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  tenant_mismatch: 401,
  tenant_not_found: 404,
  invalid_credentials: 401,
  /** 410 rather than 400: the link *was* valid and is now permanently gone. */
  token_invalid: 410,

  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  idempotency_key_reused: 409,
  last_admin_required: 409,
  /**
   * 400 rather than 409: nothing raced and nothing collided. The definition
   * names a row that is gone, which is a fact about the request's content — the
   * caller just did not author it.
   */
  workflow_reference_broken: 400,
  payload_too_large: 413,
  rate_limited: 429,

  feature_not_in_plan: 403,
  plan_limit_exceeded: 402,
  subscription_inactive: 402,

  whatsapp_window_expired: 409,
  whatsapp_template_invalid: 400,
  whatsapp_send_failed: 502,
  /**
   * 400 rather than 502: Meta answered. What it refused was the caller's code or
   * the grant behind it, which is a fact about the request, not about Meta's
   * availability — `upstream_unavailable` and `rate_limited` cover that case and
   * keep their own statuses.
   */
  whatsapp_signup_failed: 400,
  webhook_signature_invalid: 401,

  upstream_unavailable: 502,
  internal_error: 500,
};

export function httpStatusForErrorCode(code: ApiErrorCode): number {
  return API_ERROR_STATUS[code];
}

// ---------------------------------------------------------------------------
// `whatsapp_signup_failed` — the reasons, and how one reaches a client
// (TAR-161, 0002 amendment 2)
// ---------------------------------------------------------------------------

/**
 * Why an Embedded Signup run could not be turned into a connected WABA.
 *
 * Published because the console's next action differs per case and the code
 * alone cannot carry it: the first three are "re-run the flow" — with the
 * missing permissions granted, for the third — and the fourth is "the grant does
 * not cover this WABA", which is a support conversation and not something the
 * tenant can fix by trying again.
 *
 * `insufficient_permissions` is also what an environment with no
 * `META_APP_ID` answers. That is the fail-closed default rather than a
 * misclassification: nothing was granted to us that we can act on, and the
 * alternative — reporting a configuration gap to a tenant — tells the one party
 * who cannot fix it.
 *
 * Additive like the code list: a reader that does not recognise a value must
 * treat it as an unspecified failure, never crash. `whatsAppSignupFailureReason`
 * is written that way.
 */
export const WHATSAPP_SIGNUP_FAILURE_REASONS = [
  /** The 30-second code was spent before the exchange. Re-run the flow. */
  'code_expired',
  /** Meta rejected the code outright — malformed, already exchanged, or not ours. */
  'code_invalid',
  /** The grant is missing a scope the connection needs. Re-run and grant it. */
  'insufficient_permissions',
  /** The token cannot read the `wabaId` the caller named. Nothing is stored. */
  'waba_mismatch',
] as const;

export const WhatsAppSignupFailureReasonSchema = z.enum(WHATSAPP_SIGNUP_FAILURE_REASONS);

export type WhatsAppSignupFailureReason = (typeof WHATSAPP_SIGNUP_FAILURE_REASONS)[number];

/**
 * The `details` entry the reason travels in.
 *
 * 0002 writes the reason as `details.reason`, and the envelope this platform
 * shipped in TAR-38 does not have that shape: `ApiErrorSchema.details` is an
 * array of `{ path, message }`. Rather than widen the envelope for one code —
 * which every existing client parses and no other code needs — the reason rides
 * as one entry under a fixed path, and these two functions are the only place
 * that encoding is written down. Widening `details` stays available later; this
 * does not foreclose it.
 */
export const WHATSAPP_SIGNUP_FAILURE_REASON_PATH = 'reason';

/** Builds the `details` an API handler attaches to `whatsapp_signup_failed`. */
export function whatsAppSignupFailureDetails(
  reason: WhatsAppSignupFailureReason,
): ApiErrorDetail[] {
  return [{ path: WHATSAPP_SIGNUP_FAILURE_REASON_PATH, message: reason }];
}

/**
 * Reads the reason back out of an error envelope, or `null` when there is none
 * this build knows about.
 *
 * `null` rather than a throw for an unrecognised value: a console running
 * yesterday's bundle against an API that has published a fifth reason must fall
 * back to the generic message, exactly as `ApiErrorSchema.code` staying a plain
 * string lets it fall back on an unknown code.
 */
export function whatsAppSignupFailureReason(error: ApiError): WhatsAppSignupFailureReason | null {
  const detail = error.error.details?.find(
    (candidate) => candidate.path === WHATSAPP_SIGNUP_FAILURE_REASON_PATH,
  );
  const parsed = WhatsAppSignupFailureReasonSchema.safeParse(detail?.message);

  return parsed.success ? parsed.data : null;
}
