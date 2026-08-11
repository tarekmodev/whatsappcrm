import { whatsAppSignupFailureReason } from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/error';
import { content } from '@/content/en';

/**
 * Every way connecting a WhatsApp Business Account can end other than connected,
 * and the one place an API answer is turned into one.
 *
 * The list is wider than `WHATSAPP_SIGNUP_FAILURE_REASONS` because the console
 * meets failures the API never sees: Meta's window closed, Meta's script blocked.
 * It is also wider than the reasons alone because `conflict`, `rate_limited` and
 * `upstream_unavailable` arrive as their own codes with no `details.reason` — the
 * amendment's table lists all seven and gives each a different next action, and
 * flattening any of them into "something went wrong" is precisely what the
 * taxonomy exists to prevent (0002, amendment 2).
 *
 * `signup_failed` is the fall-back inside `whatsapp_signup_failed`: a reason this
 * build does not recognise, or a failure the API published without one. It keeps
 * the API's own message, which is authored, tenant-facing copy — see
 * `SIGNUP_FAILURE_MESSAGES` in `embedded-signup.service.ts` — and is the only
 * case where a server message is shown to a user.
 */
export const WHATSAPP_CONNECT_FAILURES = [
  // --- Published `details.reason` values ------------------------------------
  'code_expired',
  'code_invalid',
  'insufficient_permissions',
  'waba_mismatch',
  /** `whatsapp_signup_failed` with no reason, or one this build does not know. */
  'signup_failed',

  // --- Other API codes the amendment's table names --------------------------
  'conflict',
  'rate_limited',
  'upstream_unavailable',
  'forbidden',

  // --- Ended in the browser, before or instead of a request -----------------
  /** `CANCEL`, or Meta's window closed without an authorisation. */
  'cancelled',
  /** Meta's own `ERROR` event. */
  'meta_error',
  /** Meta's SDK never loaded — blocked, offline, or refused. */
  'sdk_unavailable',

  'unknown',
] as const;

export type WhatsAppConnectFailure = (typeof WHATSAPP_CONNECT_FAILURES)[number];

export interface WhatsAppConnectFailureReport {
  readonly failure: WhatsAppConnectFailure;
  /**
   * The API's authored message, carried only for `signup_failed` where our own
   * copy has nothing more specific to say. `null` everywhere else, so a server
   * message can never leak into a screen that already has better words.
   */
  readonly detail: string | null;
  readonly requestId: string | null;
}

export interface WhatsAppConnectFailureCopy {
  readonly heading: string;
  readonly body: string;
}

/**
 * Indexing the content table by the union is what makes it exhaustive: a failure
 * added above without copy is a type error here rather than an empty panel.
 */
export function connectFailureCopy(failure: WhatsAppConnectFailure): WhatsAppConnectFailureCopy {
  return content.whatsapp.connectFailures[failure];
}

/**
 * Whether offering the button again is honest.
 *
 * The three that are not: the grant does not cover the WABA, the WABA belongs to
 * somebody else, and the caller lost the permission. Re-running Embedded Signup
 * changes none of them, and a retry affordance that cannot work is worse than
 * none — it costs the user another trip through Meta to learn the same thing.
 */
export function isConnectFailureRetryable(failure: WhatsAppConnectFailure): boolean {
  return !NON_RETRYABLE_FAILURES.has(failure);
}

const NON_RETRYABLE_FAILURES = new Set<WhatsAppConnectFailure>([
  'waba_mismatch',
  'conflict',
  'forbidden',
  // The script is blocked for this page load; a click cannot un-block it.
  'sdk_unavailable',
]);

/** A failure decided in the browser, with no request behind it. */
export function connectFailure(failure: WhatsAppConnectFailure): WhatsAppConnectFailureReport {
  return { failure, detail: null, requestId: null };
}

/**
 * Maps an API refusal onto the taxonomy.
 *
 * The reason is read with the contract's own `whatsAppSignupFailureReason`, which
 * is the only place `details.reason`'s encoding is written down and which already
 * answers `null` for a value this build does not recognise — so a console running
 * yesterday's bundle against an API that published a fifth reason degrades to the
 * generic message instead of crashing.
 */
export function connectFailureFromError(error: unknown): WhatsAppConnectFailureReport {
  if (!(error instanceof ApiRequestError)) {
    return connectFailure('unknown');
  }

  if (error.code === 'whatsapp_signup_failed') {
    const reason = error.envelope === null ? null : whatsAppSignupFailureReason(error.envelope);

    return {
      failure: reason ?? 'signup_failed',
      detail: reason === null ? error.message : null,
      requestId: error.requestId,
    };
  }

  return {
    failure: MAPPED_ERROR_CODES[error.code] ?? 'unknown',
    detail: null,
    requestId: error.requestId,
  };
}

/**
 * The rest of amendment 2's table. Every other code — including `internal_error`
 * and anything published after this build — falls through to `unknown`, whose
 * copy says "start again" without claiming to know why.
 */
const MAPPED_ERROR_CODES: Readonly<Record<string, WhatsAppConnectFailure>> = {
  conflict: 'conflict',
  rate_limited: 'rate_limited',
  upstream_unavailable: 'upstream_unavailable',
  forbidden: 'forbidden',
};
