import { AUTH_POLICY } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ApiRequestError } from '@/lib/api/error';
import type { ActionResult } from '@/lib/actions/result';

/**
 * Turns an API failure into copy an unauthenticated user can act on.
 *
 * The API's own `message` is deliberately never shown here. On the signed-in
 * surface `people.actions.ts` passes a few of them through, because an admin can
 * act on "that email already exists"; on the sign-in screen every message is
 * about an account the caller has not proved they own, so the console renders its
 * own line from the content layer for each code it recognises and a neutral
 * fallback for everything else.
 *
 * `token_invalid` is absent on purpose. A dead invitation link is a *screen
 * state*, not a form error, so the invite flow branches on it before it gets
 * here — on the lookup and on the accept alike, because the server re-checks the
 * invitation at both steps.
 */

const MS_PER_MINUTE = 60 * 1000;

/** Minutes, from the contract's own constant — never a literal in copy. */
const LOCKOUT_MINUTES = Math.round(AUTH_POLICY.loginLockoutMs / MS_PER_MINUTE);

const SHARED_MESSAGES: Readonly<Record<string, string>> = {
  invalid_credentials: content.auth.invalidCredentialsError,
  // A lockout answers 429, not a code of its own — a distinct code would confirm
  // the address belongs to a real account (ADR 0005).
  rate_limited: content.auth.lockedOutError(LOCKOUT_MINUTES),
  subscription_inactive: content.auth.workspaceInactiveError,
  tenant_not_found: content.auth.workspaceNotFoundError,
  // The screen validates against the contract's schemas before submitting, so
  // reaching this means the two disagreed. Generic, and logged below.
  validation_failed: content.form.genericSubmitError,
};

export interface AuthErrorOptions {
  /** Shown for a code this screen does not recognise. */
  fallback: string;
  /** Screen-specific codes, merged over the shared ones. */
  overrides?: Readonly<Record<string, string>>;
}

export function toAuthErrorResult<T>(
  error: unknown,
  { fallback, overrides = {} }: AuthErrorOptions,
): ActionResult<T> {
  if (error instanceof ApiRequestError) {
    const message = overrides[error.code] ?? SHARED_MESSAGES[error.code];

    if (message === undefined) {
      // Never swallowed: the code is what a support conversation starts from.
      console.error('Unmapped auth failure', error.code, error.requestId);
    }

    return { status: 'error', message: message ?? fallback, requestId: error.requestId };
  }

  // A network drop, or a response that did not match the contract.
  console.error('Auth request failed', error);

  return { status: 'error', message: fallback, requestId: null };
}

/** True for the one failure the invite screen renders as a state rather than an error. */
export function isDeadLinkError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'token_invalid';
}
