import { ApiException } from '../common/errors/api.exception';
import { PlanLimitExceededError } from '../entitlements/entitlements.errors';
import { translatePeopleFailure } from '../people/people.http';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import {
  CurrentPasswordIncorrectError,
  InvalidCredentialsError,
  InviteNotFoundError,
  InviteNotPendingError,
  InviteTokenInvalidError,
  RateLimitedError,
  RealtimeTicketUnavailableError,
  ResetTokenInvalidError,
  SessionNotFoundError,
} from './identity.errors';

/**
 * The one place an identity-domain failure becomes an HTTP answer, mirroring
 * `people.http.ts`.
 *
 * Several of the mappings are deliberately less informative than they could be,
 * and that is the point:
 *
 *   * A lockout answers `rate_limited` rather than a code of its own, and so
 *     does a throttled address — the same code and the same message, so the
 *     answer cannot be read as "that account exists". A distinct code would
 *     confirm the address belongs to a real account, which is exactly what the
 *     identical `invalid_credentials` answer above it is careful never to say.
 *   * A session id that is not the caller's answers `not_found` rather than
 *     `forbidden`, because a 403 confirms the id exists.
 *   * A wrong current password on a signed-in change answers
 *     `invalid_credentials`, the same code login uses, so a client has one
 *     branch for "the password you typed is wrong" wherever it typed it.
 *
 * The one that says *more* is `token_invalid` (410) for a dead reset or invite
 * link, never `not_found`: those screens have to offer "ask for a new one",
 * which needs to be distinguishable from a page that never existed. It leaks
 * nothing — the token is 256 bits of uniform entropy, so anybody able to ask
 * already holds it.
 *
 * The one that is not about the caller at all is `upstream_unavailable` (502)
 * for a realtime ticket that could not be stored: the session is fine and the
 * request was correct, and reporting a Redis outage as anything in the 4xx range
 * would send a client off re-authenticating against a problem authentication
 * cannot fix.
 *
 * `reason` travels as a detail entry rather than as the `{ kind, reason }`
 * object TAR-53 and ADR 0005 describe, because TAR-38 fixed `details` as an
 * array of `{ path, message }`, and widening the envelope for one code is a
 * change to every error in the product. Flagged to the architect.
 *
 * `TenantNotActiveError` is mapped here too. It reaches this path when a tenant
 * is suspended between `HostTenantGuard`'s read and the login statement — a
 * race rather than a normal flow, but one an unauthenticated caller can
 * observe, and a 500 would report an operator's deliberate action as a fault.
 *
 * Anything it does not recognise is handed to `translatePeopleFailure`, because
 * the invite flow raises people-domain errors verbatim — an address that
 * already has an account, a role a supervisor may not assign, a team id from
 * another tenant — and those must answer with the same code here as they do on
 * `PATCH /users/{id}`. One condition, one status, wherever it is raised. What
 * that one does not recognise it rethrows, so a database outage is still
 * reported as a fault rather than as a failed login.
 */
export function translateIdentityFailure(error: unknown): never {
  if (error instanceof InvalidCredentialsError) {
    throw new ApiException('invalid_credentials', error.message);
  }

  if (error instanceof RateLimitedError) {
    throw new ApiException('rate_limited', error.message);
  }

  if (error instanceof SessionNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof ResetTokenInvalidError || error instanceof InviteTokenInvalidError) {
    throw new ApiException('token_invalid', error.message, [
      { path: 'token', message: error.reason },
    ]);
  }

  if (error instanceof CurrentPasswordIncorrectError) {
    throw new ApiException('invalid_credentials', error.message);
  }

  if (error instanceof InviteNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof InviteNotPendingError) {
    throw new ApiException('conflict', error.message);
  }

  if (error instanceof RealtimeTicketUnavailableError) {
    throw new ApiException('upstream_unavailable', error.message);
  }

  if (error instanceof PlanLimitExceededError) {
    // The published code for every quota (0002's taxonomy, 402). The limit
    // travels in `details` rather than in a code of its own, so a console can
    // branch on which ceiling was hit — and render "3 of 3" — without the error
    // vocabulary growing a member per plan limit.
    throw new ApiException('plan_limit_exceeded', error.message, [
      { path: error.limit, message: `${error.used} of ${error.cap} in use` },
    ]);
  }

  if (error instanceof TenantNotActiveError) {
    throw new ApiException(
      'subscription_inactive',
      'This workspace is not active. Contact your administrator.',
    );
  }

  return translatePeopleFailure(error);
}
