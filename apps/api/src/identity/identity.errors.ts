/**
 * Typed failures the identity services raise, mapped to error codes by
 * `identity.http.ts`.
 *
 * Domain errors rather than `ApiException`s thrown from the service layer,
 * matching `people.errors.ts`: these services are also driven by fixtures and
 * — once TAR-55 lands — by the invite-acceptance flow, neither of which has an
 * HTTP response to put a status on.
 *
 * The messages matter more here than elsewhere, because they are read by
 * somebody who has just failed to prove who they are. None of them describes
 * the state of an account.
 */

/**
 * Wrong password, unknown address, an invited account with no password set, or
 * a user who is suspended or removed.
 *
 * **One error for all four, with one message.** Distinguishing them turns the
 * login endpoint into a user-enumeration oracle — and so does answering them at
 * measurably different speeds, which is why `PasswordService.verifyDummy`
 * exists and why nothing in this class is parameterised by which case it was.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Those credentials are not valid.');
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * The account has crossed `AUTH_POLICY.loginFailureThreshold` and is locked
 * until the window elapses.
 *
 * Answered as `rate_limited` (429) with `Retry-After`, deliberately not as a
 * distinct `account_locked` code: a code that only a real account can produce
 * confirms the address exists, which is the one thing `InvalidCredentialsError`
 * is careful not to say. A 429 says the useful half — come back later — without
 * the leak.
 */
export class AccountLockedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many failed sign-in attempts. Try again later.');
    this.name = 'AccountLockedError';
  }
}

/**
 * `DELETE /auth/sessions/{id}` naming a session that is not live, or is not the
 * caller's.
 *
 * The two are one case on purpose: `not_found` for somebody else's session id
 * rather than `forbidden`, because a 403 would confirm the id exists.
 */
export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super('No such active session.');
    this.name = 'SessionNotFoundError';
  }
}

/**
 * Why a reset link did not work, in TAR-53's vocabulary for `token_invalid`'s
 * `details`.
 *
 *   * `unknown`  — no such token. A typo, a truncated link, or a guess.
 *   * `expired`  — past `expires_at`.
 *   * `consumed` — already redeemed. Single-use is the point.
 *   * `revoked`  — the token is live, but its owner can no longer sign in.
 */
export const RESET_TOKEN_REJECTIONS = ['unknown', 'expired', 'consumed', 'revoked'] as const;

export type ResetTokenRejection = (typeof RESET_TOKEN_REJECTIONS)[number];

/**
 * Telling the holder *why* their link failed leaks nothing. The token is 256
 * bits of uniform entropy, so anyone able to ask this question already holds it
 * — and the reset screen has to offer "request a new link", which it cannot do
 * without knowing this is a dead link rather than a 404 page.
 */
const REJECTION_MESSAGES: Record<ResetTokenRejection, string> = {
  unknown: 'This password reset link is not valid. Request a new one.',
  expired: 'This password reset link has expired. Request a new one.',
  consumed: 'This password reset link has already been used. Request a new one.',
  revoked: 'This password reset link is no longer usable. Ask an administrator for access.',
};

export class ResetTokenInvalidError extends Error {
  constructor(readonly reason: ResetTokenRejection) {
    super(REJECTION_MESSAGES[reason]);
    this.name = 'ResetTokenInvalidError';
  }
}

/**
 * The `currentPassword` on a password change did not match — or the account has
 * no password set at all, which is an invited user who never accepted.
 *
 * One error for both, and one message, on the same reasoning login uses: a
 * distinct answer for "you have no password yet" would be a fact about the
 * account, and this endpoint is reachable by anyone holding a session cookie.
 */
export class CurrentPasswordIncorrectError extends Error {
  constructor() {
    super('The current password is incorrect.');
    this.name = 'CurrentPasswordIncorrectError';
  }
}
