import type {
  InviteAcceptInput,
  InvitePreviewResponse,
  LoginInput,
  SessionPrincipal,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { acceptInvite, login, lookupInvite } from '@/lib/api/auth';
import type { ActionResult } from '@/lib/actions/result';
import { isDeadLinkError, toAuthErrorResult } from './auth.errors';

/**
 * The auth screens' calls, wrapped in the same `ActionResult` union every other
 * form in the app submits through — so `useActionForm` drives them unchanged and
 * a failure keeps the user's input instead of unmounting into an error boundary.
 *
 * These are **not** server actions, and that is the point: the session arrives as
 * a `Set-Cookie` on the response, so the request has to be made by the browser
 * that will hold the cookie (see `lib/api/browser.ts`).
 */

export async function signIn(input: LoginInput): Promise<ActionResult<SessionPrincipal>> {
  try {
    return { status: 'success', data: await login(input) };
  } catch (error) {
    return toAuthErrorResult(error, { fallback: content.auth.signInFailedError });
  }
}

export async function acceptInvitation(
  input: InviteAcceptInput,
): Promise<ActionResult<SessionPrincipal>> {
  try {
    return { status: 'success', data: await acceptInvite(input) };
  } catch (error) {
    return toAuthErrorResult(error, {
      fallback: content.auth.inviteFailedError,
      // The address already has an account in this tenant — the one refusal here
      // the invitee can act on, by signing in instead.
      overrides: { conflict: content.auth.inviteAccountExistsError },
    });
  }
}

/**
 * The invite preview. A discriminated union rather than an `ActionResult`,
 * because a dead link is a screen state with its own copy and its own way out,
 * not a message above a form the user should still be looking at.
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

    console.error('Invite lookup failed', error);

    return { status: 'failed' };
  }
}
