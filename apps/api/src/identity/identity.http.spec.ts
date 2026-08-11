import { ApiException } from '../common/errors/api.exception';
import {
  CurrentPasswordIncorrectError,
  RESET_TOKEN_REJECTIONS,
  ResetTokenInvalidError,
} from './identity.errors';
import { translateIdentityFailure } from './identity.http';

function thrownBy(error: unknown): ApiException {
  try {
    translateIdentityFailure(error);
  } catch (caught: unknown) {
    return caught as ApiException;
  }

  throw new Error('translateIdentityFailure returned instead of throwing');
}

describe('translateIdentityFailure', () => {
  it.each(RESET_TOKEN_REJECTIONS)('answers 410 token_invalid for a %s token', (reason) => {
    const api = thrownBy(new ResetTokenInvalidError(reason));

    // 410 rather than 404: the reset screen has to offer "request a new link",
    // which it cannot distinguish from a missing page on a 404.
    expect(api.getStatus()).toBe(410);
    expect(api.code).toBe('token_invalid');
    expect(api.details).toEqual([{ path: 'token', message: reason }]);
  });

  it('never leaks the token into the answer', () => {
    const api = thrownBy(new ResetTokenInvalidError('expired'));

    expect(JSON.stringify(api.details)).not.toContain('$argon2');
    expect(api.message).toMatch(/request a new one/i);
  });

  it('answers 401 invalid_credentials for a wrong current password', () => {
    const api = thrownBy(new CurrentPasswordIncorrectError());

    expect(api.getStatus()).toBe(401);
    expect(api.code).toBe('invalid_credentials');
  });

  it('rethrows anything it does not recognise, so a fault stays a fault', () => {
    const fault = new Error('the database went away');

    expect(() => translateIdentityFailure(fault)).toThrow(fault);
  });
});
