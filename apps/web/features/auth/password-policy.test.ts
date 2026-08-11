import { describe, expect, it } from 'vitest';
import { AUTH_POLICY } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { hasErrors, validateNewPassword } from './password-policy';

/**
 * The client-side half of the password rule. Tested here once rather than through
 * each of the two forms that use it, and asserted against `AUTH_POLICY` rather
 * than against a written-down twelve — if the contract moves, these move with it.
 */

const VALID = 'a-perfectly-fine-passphrase';

describe('validateNewPassword', () => {
  it('accepts a password that satisfies the contract, confirmed', () => {
    expect(validateNewPassword(VALID, VALID)).toEqual({});
    expect(hasErrors(validateNewPassword(VALID, VALID))).toBe(false);
  });

  it('asks for a password when the field is empty', () => {
    expect(validateNewPassword('', '')).toEqual({
      password: content.auth.passwordRequiredError,
    });
  });

  it('rejects one character below the contract minimum', () => {
    const tooShort = 'x'.repeat(AUTH_POLICY.passwordMinLength - 1);

    expect(validateNewPassword(tooShort, tooShort)).toEqual({
      password: content.auth.passwordTooShortError(AUTH_POLICY.passwordMinLength),
    });
  });

  it('accepts exactly the contract minimum', () => {
    const exact = 'x'.repeat(AUTH_POLICY.passwordMinLength);

    expect(validateNewPassword(exact, exact)).toEqual({});
  });

  it('rejects one character above the contract maximum', () => {
    // The ceiling is not cosmetic: argon2id does not truncate, so an unbounded
    // password is unbounded memory-hard hashing on an unauthenticated endpoint.
    const tooLong = 'x'.repeat(AUTH_POLICY.passwordMaxLength + 1);

    expect(validateNewPassword(tooLong, tooLong)).toEqual({
      password: content.auth.passwordTooLongError(AUTH_POLICY.passwordMaxLength),
    });
  });

  it('reports a mismatched confirmation on the confirmation field', () => {
    expect(validateNewPassword(VALID, `${VALID}!`)).toEqual({
      confirmation: content.auth.passwordMismatchError,
    });
  });

  it('does not complain about the confirmation while the password itself is invalid', () => {
    // Otherwise a short password reports two errors, one of which stops being
    // true the moment the first is fixed.
    expect(validateNewPassword('short', 'something else')).toEqual({
      password: content.auth.passwordTooShortError(AUTH_POLICY.passwordMinLength),
    });
  });
});
