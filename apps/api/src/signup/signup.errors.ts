/**
 * The failures self-signup produces, as typed domain errors rather than
 * `HttpException`s — the same split `identity.errors.ts` makes, and for the same
 * reason: a service has no business choosing a status code, and `signup.http.ts`
 * is the one place that decides.
 *
 * **What is deliberately not here is as important as what is.** There is no
 * "that address already signed up" error and no "that address already has an
 * account" error, because both would answer a question an anonymous caller is
 * not entitled to ask. `POST /signup` answers `202` whatever it found — see
 * `TenantSignupService.request`.
 */

export abstract class SignupError extends Error {
  protected constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Self-signup is switched off for this deployment (`SIGNUP_ENABLED=false`).
 *
 * Reported as `not_found`, never `forbidden`: a reseller who has turned
 * self-serve off does not want the endpoint confirming it exists, and a 403
 * would say "this feature is here, you just may not use it" to anybody who
 * probed. TAR-36's assumption is that such a deployment falls back to TAR-19's
 * operator-provisioned path, which has its own authenticated surface.
 */
export class SignupDisabledError extends SignupError {
  constructor() {
    super('No signup endpoint is served here.');
  }
}

/**
 * The requested slug is taken — by a provisioned tenant, or by a signup that is
 * still in somebody's inbox.
 *
 * The **one** thing signup will tell an anonymous caller, and 0009 decision 3
 * accepts it once and explicitly: the platform subdomain is a public DNS name,
 * so the same answer is already available to anyone who cares to look it up.
 * Refusing to answer would only mean the customer discovers it after checking
 * their email, at the one step they cannot fix without starting over.
 */
export class SlugUnavailableError extends SignupError {
  constructor(readonly slug: string) {
    super(`The address ${slug} is already taken. Choose another.`);
  }
}

/** Why a verification token was refused. Travels as a detail entry, never a distinct code. */
export type SignupTokenRejection = 'unknown' | 'expired' | 'consumed';

/**
 * The verification token is unknown, lapsed, or has already been spent.
 *
 * All three answer `token_invalid` (410) with the reason in `details`, matching
 * what an invite or reset link does: the verify screen has to be able to offer
 * "send me another one", which needs to be distinguishable from a page that
 * never existed. It leaks nothing — the token is 256 bits of uniform entropy, so
 * anybody able to ask already holds it.
 */
export class SignupTokenInvalidError extends SignupError {
  constructor(readonly reason: SignupTokenRejection) {
    super('That verification link is no longer valid. Request a new one.');
  }
}

/**
 * Too many signups from one address, or too many for one email.
 *
 * The same code and message as every other throttle in the product
 * (`rate_limited`), so the answer cannot be read as "that address is known".
 */
export class SignupRateLimitedError extends SignupError {
  constructor() {
    super('Too many signup attempts. Wait a little and try again.');
  }
}
