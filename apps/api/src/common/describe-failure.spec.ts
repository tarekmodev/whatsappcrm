import { describeFailure } from './describe-failure';
import { TimeoutError } from './with-timeout';

describe('describeFailure', () => {
  it('prefers the system error code over the class name', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432'), {
      code: 'ECONNREFUSED',
    });

    expect(describeFailure(refused)).toBe('ECONNREFUSED');
  });

  it('unwraps an AggregateError, which is what a failed pg connection surfaces as', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });

    expect(describeFailure(new AggregateError([inner], 'all attempts failed'))).toBe(
      'ECONNREFUSED',
    );
  });

  it('falls back to the error name when there is no code', () => {
    expect(describeFailure(new TimeoutError('database ping', 2000))).toBe('TimeoutError');
  });

  it('never leaks the message, which carries hosts and ports', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432'), {
      code: 'ECONNREFUSED',
    });

    expect(describeFailure(refused)).not.toContain('10.0.0.7');
    expect(describeFailure(refused)).not.toContain('5432');
  });

  it('handles something that is not an error at all', () => {
    expect(describeFailure('kaboom')).toBe('unknown error');
  });
});
