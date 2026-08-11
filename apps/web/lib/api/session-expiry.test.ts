import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@/lib/api/http';
import { isSessionExpiredError } from './session-expiry';

/**
 * The one definition of "this caller no longer has a session". Two things must
 * hold, and the second is what TAR-163 broke:
 *
 *   1. every answer that really does mean the session is gone reaches it —
 *      including a 401 nobody could parse;
 *   2. a 401 that is about a credential in the *body* does not, because signing
 *      somebody out for mistyping their current password is a worse answer than
 *      the inline error the form already has.
 */

function refuse(status: number, code: string): ApiRequestError {
  return new ApiRequestError(status, code, 'Refused', null);
}

describe('isSessionExpiredError', () => {
  it.each([
    ['no session, or one that expired or was revoked', 401, 'unauthenticated'],
    ['a session replayed against another tenant’s host', 401, 'tenant_mismatch'],
    ['a 401 whose body was not the error envelope', 401, 'malformed_error'],
    ['a 401 that was not JSON at all', 401, 'upstream_error'],
  ])('reads %s as a lost session', (_case, status, code) => {
    expect(isSessionExpiredError(refuse(status, code))).toBe(true);
  });

  /**
   * TAR-163. The API answers a wrong `currentPassword` with 401
   * `invalid_credentials` — the same code login uses — and leaves the session
   * alone. Treating it as an expiry bounced the user from `/settings/security`
   * to sign-in with no message, effectively logging them out on the first typo.
   */
  it('does not read a wrong current password as a lost session', () => {
    expect(isSessionExpiredError(refuse(401, 'invalid_credentials'))).toBe(false);
  });

  it.each([
    ['a permission the role lacks', 403, 'forbidden'],
    ['an unreachable API', 502, 'upstream_unavailable'],
    ['a dead reset link', 410, 'token_invalid'],
  ])('leaves %s to the caller', (_case, status, code) => {
    expect(isSessionExpiredError(refuse(status, code))).toBe(false);
  });

  it('says nothing about an error that did not come from the API', () => {
    expect(isSessionExpiredError(new Error('boom'))).toBe(false);
    expect(isSessionExpiredError(null)).toBe(false);
  });
});
