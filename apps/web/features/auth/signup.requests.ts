import type {
  SignupAcceptedResponse,
  SignupCompletedResponse,
  SignupInput,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import {
  checkSlugAvailability,
  requestSignup,
  resendSignupVerification,
  verifySignup,
} from '@/lib/api/auth-browser';
import { ApiRequestError } from '@/lib/api/error';
import type { ActionResult } from '@/lib/actions/result';
import { isDeadLinkError, toAuthErrorResult } from './auth.errors';

/**
 * Public self-signup's four calls, wrapped in the same `ActionResult` union
 * every other form in the console submits through — the sibling of
 * `auth.requests.ts`, and here for the same reason: none of these can be a
 * server action. See `lib/api/auth-browser.ts` for which of the four is stopped
 * by the session cookie and which by the API's per-caller throttle.
 *
 * ## What travels through the success channel, and why
 *
 * Three refusals are modelled as **outcomes** rather than as form errors, on the
 * rule `auth.requests.ts` already follows for a dead invitation: a message above
 * a form is only useful when editing the form could make the submit succeed.
 *
 *   - **`slug_taken`.** Editable, but not by the form as a whole — it belongs on
 *     the one field that caused it, next to the cursor that fixes it, rather
 *     than in a banner above six fields that were all fine.
 *   - **`disabled`.** `SIGNUP_ENABLED=false` on this deployment. Nothing typed
 *     into this form will ever be accepted, so the form itself is the wrong
 *     thing to still be looking at.
 *   - **`dead_link`.** An expired or already-spent verification link. The way
 *     out is a new signup, not another press of the same button.
 */

// ---------------------------------------------------------------------------
// Creating the workspace
// ---------------------------------------------------------------------------

export type SignupOutcome =
  /** The signup is recorded and the verification link is in the post. */
  | { kind: 'accepted'; accepted: SignupAcceptedResponse }
  /** Somebody claimed the address between the availability check and the submit. */
  | { kind: 'slug_taken' }
  /** Self-signup is switched off for this deployment. */
  | { kind: 'disabled' };

export async function createWorkspace(input: SignupInput): Promise<ActionResult<SignupOutcome>> {
  try {
    return { status: 'success', data: { kind: 'accepted', accepted: await requestSignup(input) } };
  } catch (error) {
    if (isSlugConflict(error)) {
      return { status: 'success', data: { kind: 'slug_taken' } };
    }

    if (isSignupDisabled(error)) {
      return { status: 'success', data: { kind: 'disabled' } };
    }

    return toAuthErrorResult(error, {
      fallback: content.auth.signupFailedError,
      overrides: { rate_limited: content.auth.signupRateLimitedError },
    });
  }
}

// ---------------------------------------------------------------------------
// Confirming the address
// ---------------------------------------------------------------------------

export type SignupVerification =
  /** The tenant exists, and the response says where it lives. */
  | { kind: 'completed'; completed: SignupCompletedResponse }
  /** The token is unknown, lapsed, or has already been spent. */
  | { kind: 'dead_link' }
  | { kind: 'disabled' };

export async function completeSignup(token: string): Promise<ActionResult<SignupVerification>> {
  try {
    return {
      status: 'success',
      data: { kind: 'completed', completed: await verifySignup({ token }) },
    };
  } catch (error) {
    if (isDeadLinkError(error)) {
      return { status: 'success', data: { kind: 'dead_link' } };
    }

    if (isSignupDisabled(error)) {
      return { status: 'success', data: { kind: 'disabled' } };
    }

    return toAuthErrorResult(error, { fallback: content.auth.verifyFailedError });
  }
}

/**
 * A second copy of the link.
 *
 * A plain `ActionResult`, unlike the two above: every refusal it can produce is
 * one the reader answers by waiting or by starting over, and both of those are
 * already on the card this is pressed from. `rate_limited` covers both of
 * `SIGNUP_POLICY`'s resend bounds — the per-row count and the per-address window
 * — because the API deliberately gives them one code.
 */
export async function resendVerification(
  email: string,
): Promise<ActionResult<SignupAcceptedResponse>> {
  try {
    return { status: 'success', data: await resendSignupVerification({ email }) };
  } catch (error) {
    return toAuthErrorResult(error, {
      fallback: content.auth.signupResendFailedError,
      overrides: {
        rate_limited: content.auth.signupResendRateLimitedError,
        // Unreachable from the card that offers this — reaching it means a
        // signup succeeded a moment ago — but mapped rather than left to log
        // itself as an unmapped auth failure if a deployment is switched off
        // mid-flow.
        not_found: content.auth.signupResendFailedError,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Is the address free?
// ---------------------------------------------------------------------------

/**
 * What the availability check found.
 *
 * `unknown` is a first-class answer rather than an error, and that is the point:
 * the check is a courtesy that saves somebody a trip to their inbox, and the
 * submit is the authority. A check that could not run must never be a reason the
 * form cannot be submitted.
 *
 * `superseded` means the caller abandoned this check because what it was about
 * changed under it — another keystroke. Distinct from `unknown` so the hook can
 * drop it silently instead of showing "we could not check that" for a value
 * nobody is asking about any more.
 */
export type SlugAvailability = 'available' | 'taken' | 'unknown' | 'superseded';

export async function readSlugAvailability(
  slug: string,
  signal: AbortSignal,
): Promise<SlugAvailability> {
  try {
    return (await checkSlugAvailability(slug, signal)).available ? 'available' : 'taken';
  } catch (error) {
    if (signal.aborted) {
      return 'superseded';
    }

    // Not swallowed, but not shouted about either: a throttled check (429) is
    // the expected cost of asking while somebody types, and logging it at
    // `error` would fill a console with something working as designed.
    if (error instanceof ApiRequestError && error.code === 'rate_limited') {
      return 'unknown';
    }

    console.error('Slug availability check failed', error);

    return 'unknown';
  }
}

/**
 * A taken slug answers `conflict` (409), not `validation_failed`: the body was
 * well-formed and what refused it was the state of the world. Only that code is
 * worth re-prompting for a different name, which is why it is matched here
 * rather than treated as one more failed submit.
 */
function isSlugConflict(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'conflict';
}

/**
 * `SIGNUP_ENABLED=false` answers `not_found`, never `forbidden` — a reseller who
 * has turned self-serve off does not want the endpoint confirming to a prober
 * that it exists (`apps/api/src/signup/signup.errors.ts`).
 *
 * A genuinely absent route answers the same thing, and that is fine: from this
 * screen's side both mean "no signup endpoint is served here", and both want the
 * same sentence.
 */
function isSignupDisabled(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'not_found';
}
