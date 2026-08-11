'use server';

import { unstable_rethrow } from 'next/navigation';
import {
  PasswordChangeInputSchema,
  PasswordResetConfirmInputSchema,
  PasswordResetRequestInputSchema,
} from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { changePassword, confirmPasswordReset, requestPasswordReset } from '@/lib/api/auth';
import { content } from '@/content/en';
import type { ActionResult } from '@/lib/actions/result';

/**
 * The password flows' mutations (TAR-61), against TAR-57's endpoints.
 *
 * Like `people.actions.ts`, each one validates against the *contract's* schema —
 * the same object the API validates with — and returns a discriminated result
 * rather than throwing, so the calling form renders an inline error and keeps
 * what the user typed.
 *
 * Two of the three are deliberately **unauthenticated**. A server action is a
 * public endpoint, and these are reachable by someone who has lost their password
 * by definition; there is nothing here to assert a permission against. What keeps
 * them safe is that neither one tells the caller anything: the request answers
 * identically whatever the address, and the confirm needs 256 bits of token.
 */

export async function requestPasswordResetAction(
  input: unknown,
): Promise<ActionResult<{ email: string }>> {
  const parsed = PasswordResetRequestInputSchema.safeParse(input);

  if (!parsed.success) {
    return failure(content.form.invalidEmailError);
  }

  try {
    await requestPasswordReset(parsed.data);

    return { status: 'success', data: { email: parsed.data.email } };
  } catch (error) {
    // The endpoint is unconditionally 204, so anything caught here is transport
    // or infrastructure — never "no such user", which it does not say.
    return transportFailure('Password reset request failed', error);
  }
}

/**
 * How a reset attempt ended.
 *
 * A dead link is an **answer, not a form error**: the screen replaces itself with
 * a "request a new link" state, because there is nothing left on that form worth
 * submitting. Routing it through `formError` would render a message above a form
 * whose only remaining useful control is a link somewhere else.
 */
export type ResetOutcome = { kind: 'reset' } | { kind: 'link_unusable'; message: string };

export async function confirmPasswordResetAction(
  input: unknown,
): Promise<ActionResult<ResetOutcome>> {
  const parsed = PasswordResetConfirmInputSchema.safeParse(input);

  if (!parsed.success) {
    return failure(content.auth.genericFailure);
  }

  try {
    await confirmPasswordReset(parsed.data);

    return { status: 'success', data: { kind: 'reset' } };
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === TOKEN_INVALID) {
      // Safe to show verbatim: `identity.errors.ts` writes these messages for the
      // person holding the link, and says which of unknown / expired / used /
      // revoked it was. It leaks nothing — anyone able to ask already holds the
      // token — and the screen cannot offer the right next step without it.
      return { status: 'success', data: { kind: 'link_unusable', message: error.message } };
    }

    return transportFailure('Password reset confirmation failed', error);
  }
}

export async function changePasswordAction(input: unknown): Promise<ActionResult<undefined>> {
  const parsed = PasswordChangeInputSchema.safeParse(input);

  if (!parsed.success) {
    return failure(content.auth.genericFailure);
  }

  try {
    await changePassword(parsed.data);

    return { status: 'success', data: undefined };
  } catch (error) {
    return transportFailure('Password change failed', error);
  }
}

const TOKEN_INVALID = 'token_invalid';

/**
 * Codes whose message is written for the person reading it and can be shown as
 * it stands. `invalid_credentials` is a wrong current password; `rate_limited` is
 * a lockout, which says "try again later" and deliberately not whose account it
 * was. Everything else falls back to the generic line, because an internal
 * message is not user-facing copy.
 */
const ACTIONABLE_ERROR_CODES = new Set([
  'invalid_credentials',
  'rate_limited',
  'validation_failed',
  'subscription_inactive',
]);

function transportFailure<T>(label: string, error: unknown): ActionResult<T> {
  // First, and before anything else looks at it: the session guard behind
  // `changePassword` answers a lost session with a `redirect`, which Next
  // implements by throwing. Caught and mapped to a message, that navigation would
  // be swallowed and the user would sit on a page they are no longer signed in to.
  // `unstable_rethrow` is the documented way to let a framework-controlled throw
  // back out of a catch that also has real failures to handle.
  unstable_rethrow(error);

  if (error instanceof ApiRequestError) {
    return {
      status: 'error',
      message: ACTIONABLE_ERROR_CODES.has(error.code) ? error.message : content.auth.genericFailure,
      requestId: error.requestId,
    };
  }

  // Never swallowed: the server log keeps the detail the user must not see. It
  // never contains the password or the token — neither is in the error.
  console.error(label, error);

  return failure(content.auth.genericFailure);
}

function failure<T>(message: string): ActionResult<T> {
  return { status: 'error', message, requestId: null };
}
