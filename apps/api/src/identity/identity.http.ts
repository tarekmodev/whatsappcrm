import { ApiException } from '../common/errors/api.exception';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import {
  AccountLockedError,
  CurrentPasswordIncorrectError,
  InvalidCredentialsError,
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
 *   * A lockout answers `rate_limited` rather than a code of its own. A
 *     distinct code would confirm the address belongs to a real account, which
 *     is exactly what the identical `invalid_credentials` answer above it is
 *     careful never to say.
 *   * A session id that is not the caller's answers `not_found` rather than
 *     `forbidden`, because a 403 confirms the id exists.
 *   * A wrong current password on a signed-in change answers
 *     `invalid_credentials`, the same code login uses, so a client has one
 *     branch for "the password you typed is wrong" wherever it typed it.
 *
 * The one that says *more* is `token_invalid` (410) for a dead reset link,
 * never `not_found`: the reset screen has to offer "request a new link", which
 * needs to be distinguishable from a 404 page (TAR-53, error codes). It leaks
 * nothing — the token is 256 bits of uniform entropy, so anybody able to ask
 * already holds it.
 *
 * `TenantNotActiveError` is mapped here too. It reaches this path when a tenant
 * is suspended between `HostTenantGuard`'s read and the login statement — a
 * race rather than a normal flow, but one an unauthenticated caller can
 * observe, and a 500 would report an operator's deliberate action as a fault.
 *
 * Anything unrecognised is rethrown untouched: reporting a database outage as a
 * failed login would hide it.
 */
export function translateIdentityFailure(error: unknown): never {
  if (error instanceof InvalidCredentialsError) {
    throw new ApiException('invalid_credentials', error.message);
  }

  if (error instanceof AccountLockedError) {
    throw new ApiException('rate_limited', error.message);
  }

  if (error instanceof SessionNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof ResetTokenInvalidError) {
    // TAR-53 specifies `details: { kind, reason }`. The published envelope
    // (`ApiErrorDetailSchema`) is an array of `{ path, message }` and nothing
    // else, so the reason travels as the message on the offending field rather
    // than as a second shape the frontend would have to parse. Flagged to the
    // architect; changing the envelope is a contract change, not this story's.
    throw new ApiException('token_invalid', error.message, [
      { path: 'token', message: error.reason },
    ]);
  }

  if (error instanceof CurrentPasswordIncorrectError) {
    throw new ApiException('invalid_credentials', error.message);
  }

  if (error instanceof TenantNotActiveError) {
    throw new ApiException(
      'subscription_inactive',
      'This workspace is not active. Contact your administrator.',
    );
  }

  throw error;
}
