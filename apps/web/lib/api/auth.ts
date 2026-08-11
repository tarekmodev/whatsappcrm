import 'server-only';

import type {
  LogoutInput,
  PasswordChangeInput,
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
} from '@whatsappcrm/contracts';
import { apiRequest } from '@/lib/api/http';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * `POST /api/v1/auth/*`, the password and session half of TAR-53's contract,
 * implemented by TAR-56 and TAR-57. No component calls `fetch`; they call these
 * through a server action.
 *
 * All of them answer 204 with no body, so none returns anything — there is no
 * response shape to validate, and inventing one would be a lie about what the API
 * said. What each one *means* is documented on the function.
 *
 * The two reset endpoints go through `apiRequest` and the rest through
 * `authenticatedRequest`, and the split is deliberate: a caller who has lost their
 * password has no session to forward, and sending them through the guard would
 * bounce them to a sign-in screen they cannot get past.
 */

const AUTH_PATH = '/v1/auth';

/**
 * Ask for a reset link. Resolves for an unknown address exactly as it does for a
 * real one: the endpoint is unconditionally 204, and the screen above must not
 * reintroduce the enumeration oracle that answer exists to close.
 *
 * Unauthenticated by design — the caller has, by definition, lost their way in.
 */
export async function requestPasswordReset(input: PasswordResetRequestInput): Promise<void> {
  await apiRequest({ method: 'POST', path: `${AUTH_PATH}/password-reset`, body: input });
}

/**
 * Redeem a reset link, once. Rejects with `ApiRequestError` code `token_invalid`
 * (410) when the token is unknown, expired, already used, or belongs to an
 * account that can no longer sign in.
 *
 * On success the API revokes **every** session the account had and issues no new
 * one: the user signs in fresh, which is also how they find out the reset worked.
 */
export async function confirmPasswordReset(input: PasswordResetConfirmInput): Promise<void> {
  await apiRequest({ method: 'POST', path: `${AUTH_PATH}/password-reset/confirm`, body: input });
}

/**
 * Change a known password while signed in. Rejects with `invalid_credentials`
 * when `currentPassword` does not match.
 *
 * On success the API revokes every session *except* the caller's, which is what
 * makes this the useful action after a suspected compromise.
 */
export async function changePassword(input: PasswordChangeInput): Promise<void> {
  await authenticatedRequest({ method: 'POST', path: `${AUTH_PATH}/password`, body: input });
}

/**
 * End this session, or every session the account has.
 *
 * Always 204 — including when the session was already revoked, which is what
 * makes the sign-out button safe to press twice. The API clears its own cookie on
 * the response; because this call is made by the Next process rather than the
 * browser, that `Set-Cookie` never reaches the person signing out, so the caller
 * clears the browser's copy itself (`signOutAction`).
 */
export async function logout(input: LogoutInput): Promise<void> {
  await authenticatedRequest({ method: 'POST', path: `${AUTH_PATH}/logout`, body: input });
}
