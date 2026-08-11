import type {
  InviteAcceptInput,
  InvitePreviewResponse,
  LoginInput,
  SessionPrincipal,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { acceptInvite, login, lookupInvite } from '@/lib/api/auth-browser';
import type { ActionResult } from '@/lib/actions/result';
import { isDeadLinkError, toAuthErrorResult } from './auth.errors';

/**
 * The signed-out screens' calls, wrapped in the same `ActionResult` union every
 * other form in the console submits through — so `useActionForm` drives them
 * unchanged and a failure keeps the user's input instead of unmounting into an
 * error boundary.
 *
 * The sibling of `auth.actions.ts`, and the reason there are two: these three
 * cannot be server actions. The session arrives as a `Set-Cookie`, so the request
 * has to be made by the browser that will hold the cookie — see
 * `lib/api/auth-browser.ts`.
 */

export async function signIn(input: LoginInput): Promise<ActionResult<SessionPrincipal>> {
  try {
    return { status: 'success', data: await login(input) };
  } catch (error) {
    return toAuthErrorResult(error, { fallback: content.auth.signInFailedError });
  }
}

/**
 * `null` when the invitation died between the lookup and the submit — the API
 * re-checks it on accept, so a link that was live a minute ago can be expired,
 * withdrawn, or already used by somebody else.
 *
 * It travels through the **success** channel, exactly as `ResetOutcome` does on
 * the reset screen, because the right response is to show a different card rather
 * than to let the user keep pressing submit on a form that can no longer succeed.
 */
export type AcceptedInvite = SessionPrincipal | null;

export async function acceptInvitation(
  input: InviteAcceptInput,
): Promise<ActionResult<AcceptedInvite>> {
  try {
    return { status: 'success', data: await acceptInvite(input) };
  } catch (error) {
    if (isDeadLinkError(error)) {
      return { status: 'success', data: null };
    }

    return toAuthErrorResult(error, {
      fallback: content.auth.inviteFailedError,
      // The address already has an account in this tenant — the one refusal here
      // the invitee can act on, by signing in instead.
      overrides: { conflict: content.auth.inviteAccountExistsError },
    });
  }
}

/**
 * The invite preview. A union of its own rather than an `ActionResult`, because
 * two of its three outcomes are screen states with their own copy and their own
 * way out, not messages above a form the user should still be looking at.
 */
export type InviteLookupOutcome =
  | { status: 'ready'; preview: InvitePreviewResponse }
  | { status: 'dead-link' }
  | { status: 'failed' };

export async function loadInvitePreview(token: string): Promise<InviteLookupOutcome> {
  try {
    return { status: 'ready', preview: await lookupInvite({ token }) };
  } catch (error) {
    if (isDeadLinkError(error)) {
      return { status: 'dead-link' };
    }

    // Never swallowed: a lookup that failed for any other reason is a real fault.
    console.error('Invite lookup failed', error);

    return { status: 'failed' };
  }
}
