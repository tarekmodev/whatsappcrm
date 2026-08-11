import type { InviteListStatus } from '@whatsappcrm/contracts';

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
 * The caller has been throttled and should come back later.
 *
 * Answered as `rate_limited` (429) with `Retry-After`, deliberately not as a
 * distinct `account_locked` code: a code that only a real account can produce
 * confirms the address exists, which is the one thing `InvalidCredentialsError`
 * is careful not to say. A 429 says the useful half — come back later — without
 * the leak.
 *
 * Both subclasses carry **the same message** for the same reason. One is raised
 * only for an account that exists and the other before any account is looked
 * up, so two different messages would tell a caller which of the two happened,
 * and that is the enumeration oracle again wearing a different hat.
 *
 * The same message is necessary but not sufficient: it closes nothing unless a
 * 429 is *reachable* for an address with no account. `LoginThrottleService`'s
 * per-email lockout is what makes it reachable, at the same threshold and for
 * the same duration as `AccountLockedError` — without it, only a real account
 * could produce a 429 at all and the status would answer the question the body
 * refuses to.
 */
export abstract class RateLimitedError extends Error {
  protected constructor(readonly retryAfterSeconds: number) {
    super('Too many failed sign-in attempts. Try again later.');
    this.name = 'RateLimitedError';
  }
}

/**
 * The account has crossed `AUTH_POLICY.loginFailureThreshold` and is locked
 * until the window elapses. Durable, per account, and visible to a tenant admin
 * on `UserResponse.security` — see `LoginThrottleService`.
 */
export class AccountLockedError extends RateLimitedError {
  constructor(retryAfterSeconds: number) {
    super(retryAfterSeconds);
    this.name = 'AccountLockedError';
  }
}

/**
 * Either Redis layer refusing the attempt: the client address has crossed
 * `AUTH_POLICY.ipFailureThreshold` failures against this tenant inside
 * `AUTH_POLICY.ipFailureWindowMs`, or the typed email address has crossed
 * `AUTH_POLICY.loginFailureThreshold` and is locked for
 * `AUTH_POLICY.loginLockoutMs`.
 *
 * Raised **before** the account lookup, which is the whole point of both
 * layers: credential stuffing sprays addresses that mostly have no user row, so
 * there is nothing per-account to count. It says nothing about whether any of
 * the addresses tried exists — and because the email layer locks an unknown
 * address exactly as it locks a known one, the refusal itself does not either.
 */
export class TooManyAttemptsError extends RateLimitedError {
  constructor(retryAfterSeconds: number) {
    super(retryAfterSeconds);
    this.name = 'TooManyAttemptsError';
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
 * Why an emailed link did not work, in TAR-53's vocabulary for `token_invalid`'s
 * `details`.
 *
 *   * `unknown`  — no such token. A typo, a truncated link, or a guess.
 *   * `expired`  — past `expires_at`.
 *   * `consumed` — already redeemed. Single-use is the point.
 *   * `revoked`  — the token is live, but its owner can no longer use it.
 *
 * One vocabulary for both link kinds, reset and invite. They fail for the same
 * four reasons and a client that renders "ask for a new one" should not have to
 * learn a second spelling to do it.
 */
export const TOKEN_REJECTION_REASONS = ['unknown', 'expired', 'consumed', 'revoked'] as const;

export type TokenRejectionReason = (typeof TOKEN_REJECTION_REASONS)[number];

/**
 * Telling the holder *why* their link failed leaks nothing. The token is 256
 * bits of uniform entropy, so anyone able to ask this question already holds it
 * — and the reset screen has to offer "request a new link", which it cannot do
 * without knowing this is a dead link rather than a 404 page.
 */
const REJECTION_MESSAGES: Record<TokenRejectionReason, string> = {
  unknown: 'This password reset link is not valid. Request a new one.',
  expired: 'This password reset link has expired. Request a new one.',
  consumed: 'This password reset link has already been used. Request a new one.',
  revoked: 'This password reset link is no longer usable. Ask an administrator for access.',
};

export class ResetTokenInvalidError extends Error {
  constructor(readonly reason: TokenRejectionReason) {
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

/** An invite token that is unknown, expired, already accepted, or withdrawn. */
export class InviteTokenInvalidError extends Error {
  constructor(readonly reason: TokenRejectionReason) {
    super(`This invitation link is no longer usable (${reason}).`);
    this.name = 'InviteTokenInvalidError';
  }
}

/** No invite with that id in this tenant. Another tenant's is indistinguishable, by design. */
export class InviteNotFoundError extends Error {
  constructor(readonly inviteId: string) {
    super(`No invitation ${inviteId} in this tenant.`);
    this.name = 'InviteNotFoundError';
  }
}

/**
 * An invite that cannot be resent or withdrawn because it is no longer live.
 *
 * Distinct from `InviteNotFoundError`: the admin is looking at a real row, and
 * the answer they need is "this one was already accepted", not "it does not
 * exist".
 */
export class InviteNotPendingError extends Error {
  constructor(readonly state: Extract<InviteListStatus, 'accepted' | 'revoked'>) {
    super(`This invitation has already been ${state} and cannot be changed.`);
    this.name = 'InviteNotPendingError';
  }
}
