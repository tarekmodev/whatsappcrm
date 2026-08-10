import { z } from 'zod';

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

  // --- Request validity ------------------------------------------------------
  /** Body, query or params failed schema validation. Always carries `details`. */
  'validation_failed',
  /** Absent, or present in another tenant — the two are indistinguishable by design. */
  'not_found',
  /** Uniqueness or optimistic-concurrency conflict. */
  'conflict',
  /** An `Idempotency-Key` was replayed with a different request body. */
  'idempotency_key_reused',
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

  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  idempotency_key_reused: 409,
  payload_too_large: 413,
  rate_limited: 429,

  feature_not_in_plan: 403,
  plan_limit_exceeded: 402,
  subscription_inactive: 402,

  whatsapp_window_expired: 409,
  whatsapp_template_invalid: 400,
  whatsapp_send_failed: 502,
  webhook_signature_invalid: 401,

  upstream_unavailable: 502,
  internal_error: 500,
};

export function httpStatusForErrorCode(code: ApiErrorCode): number {
  return API_ERROR_STATUS[code];
}
