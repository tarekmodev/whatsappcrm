import { ApiException } from '../common/errors/api.exception';
import {
  EmailAlreadyRegisteredError,
  LastAdminRequiredError,
  RoleAssignmentNotPermittedError,
  RoleEscalationError,
  SelfRoleChangeError,
  TeamNameTakenError,
  TeamNotFoundError,
  UnknownReferenceError,
  UserNotFoundError,
} from './people.errors';
import { translatePeopleFailure } from './people.http';

function codeFor(error: unknown): { code: string; status: number } {
  try {
    translatePeopleFailure(error);
  } catch (thrown) {
    const failure = thrown as ApiException;

    return { code: failure.code, status: failure.getStatus() };
  }

  throw new Error('expected a translation');
}

describe('people failure translation', () => {
  // The leak this prevents: a 403 on another tenant's user id confirms the id
  // exists somewhere. RLS already hid the row; the status must not undo that.
  it('answers not_found — never forbidden — for a record the caller cannot see', () => {
    expect(codeFor(new UserNotFoundError('u1'))).toEqual({ code: 'not_found', status: 404 });
    expect(codeFor(new TeamNotFoundError('t1'))).toEqual({ code: 'not_found', status: 404 });
  });

  it('answers forbidden only for a refusal about something the caller can see', () => {
    for (const error of [
      new SelfRoleChangeError(),
      new RoleEscalationError('admin', 'supervisor'),
      new RoleAssignmentNotPermittedError('supervisor'),
    ]) {
      expect(codeFor(error)).toEqual({ code: 'forbidden', status: 403 });
    }
  });

  it('gives the last-admin refusal its own code and a 409', () => {
    expect(codeFor(new LastAdminRequiredError())).toEqual({
      code: 'last_admin_required',
      status: 409,
    });
  });

  it('answers conflict for a collision the caller can resolve', () => {
    expect(codeFor(new EmailAlreadyRegisteredError('a@b.invalid')).code).toBe('conflict');
    expect(codeFor(new TeamNameTakenError('Billing')).code).toBe('conflict');
  });

  it('names the unknown ids in the validation details', () => {
    try {
      translatePeopleFailure(new UnknownReferenceError('team', ['t1', 't2']));
      throw new Error('expected a translation');
    } catch (thrown) {
      const failure = thrown as ApiException;

      expect(failure.code).toBe('validation_failed');
      expect(failure.details).toHaveLength(2);
    }
  });

  it('rethrows anything it does not recognise, so a fault stays a fault', () => {
    const fault = new Error('connection terminated unexpectedly');

    expect(() => translatePeopleFailure(fault)).toThrow(fault);
  });
});
