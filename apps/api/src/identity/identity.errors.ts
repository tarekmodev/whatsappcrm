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
