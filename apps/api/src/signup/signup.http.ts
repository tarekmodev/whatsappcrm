import { ApiException } from '../common/errors/api.exception';
import {
  SignupDisabledError,
  SignupRateLimitedError,
  SignupTokenInvalidError,
  SlugUnavailableError,
} from './signup.errors';

/**
 * The one place a signup failure becomes an HTTP answer, mirroring
 * `identity.http.ts`.
 *
 * Two of the four mappings are deliberately not the obvious one:
 *
 *   * **A disabled deployment answers `not_found`, not `forbidden`.** 403 says
 *     "this exists, you may not use it", which is exactly what a reseller who
 *     turned self-serve off does not want announced to anybody who probes.
 *   * **A taken slug answers `conflict`, not `validation_failed`.** The body was
 *     well-formed; what refused it was the state of the world. A client
 *     distinguishes "fix your input" from "somebody got there first" on that
 *     code, and only the second is worth re-prompting for a different name.
 *
 * `token_invalid` (410) for a dead verification link matches an invite and a
 * password reset, and for the same reason: the verify screen has to be able to
 * offer "send me another one", which needs to be distinguishable from a page
 * that never existed.
 *
 * Anything it does not recognise is rethrown, so a database outage is still
 * reported as a fault rather than as a failed signup.
 */
export function translateSignupFailure(error: unknown): never {
  if (error instanceof SignupDisabledError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof SlugUnavailableError) {
    throw new ApiException('conflict', error.message, [
      { path: 'slug', message: 'That address is already taken.' },
    ]);
  }

  if (error instanceof SignupTokenInvalidError) {
    throw new ApiException('token_invalid', error.message, [
      { path: 'token', message: error.reason },
    ]);
  }

  if (error instanceof SignupRateLimitedError) {
    throw new ApiException('rate_limited', error.message);
  }

  throw error;
}
