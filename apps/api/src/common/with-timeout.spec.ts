import { TimeoutError, withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('passes a value through when the work settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'probe')).resolves.toBe('ok');
  });

  it('rejects with a labelled timeout when the work hangs', async () => {
    const hangs = new Promise<never>(() => {
      /* never settles — the case a readiness probe has to survive */
    });

    await expect(withTimeout(hangs, 10, 'database ping')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('surfaces the original failure rather than masking it as a timeout', async () => {
    const failure = new Error('connection refused');

    await expect(withTimeout(Promise.reject(failure), 50, 'probe')).rejects.toBe(failure);
  });
});
