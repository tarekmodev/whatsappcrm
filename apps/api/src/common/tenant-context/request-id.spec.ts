import { REQUEST_ID_MAX_LENGTH, resolveRequestId } from './request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('repeats a correlation id the caller sent', () => {
    expect(resolveRequestId('req_from_caller')).toBe('req_from_caller');
    expect(resolveRequestId('0198c3f1-4b2a-7c3d-8e4f-5a6b7c8d9e0f')).toBe(
      '0198c3f1-4b2a-7c3d-8e4f-5a6b7c8d9e0f',
    );
  });

  it('generates one when the caller sent none', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID);
    expect(resolveRequestId('')).toMatch(UUID);
  });

  // The header is echoed into every log line, error envelope and Sentry tag for
  // the request. An unbounded one is a caller deciding how much log volume the
  // platform pays for.
  it('refuses an id longer than the bound rather than truncating it', () => {
    const overlong = 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1);

    const resolved = resolveRequestId(overlong);

    expect(resolved).toMatch(UUID);
    expect(resolved).not.toContain('aaaaaaaaaa');
  });

  it('accepts one exactly at the bound', () => {
    const atBound = 'a'.repeat(REQUEST_ID_MAX_LENGTH);

    expect(resolveRequestId(atBound)).toBe(atBound);
  });

  it.each([
    ['a newline', 'req\nid'],
    ['a carriage return', 'req\rid'],
    ['a null byte', 'req\0id'],
    ['a quote and a brace, as a log forgery would', 'req","level":"fatal'],
    ['a space', 'req id'],
    ['a non-breaking space', 'req id'],
    ['a path separator', '../../etc/passwd'],
  ])('replaces an id containing %s', (_case, incoming) => {
    expect(resolveRequestId(incoming)).toMatch(UUID);
  });

  // Express folds a repeated header into an array. Nothing legitimate sends the
  // header twice, and picking one of them would be a guess.
  it('replaces a repeated header rather than choosing between the values', () => {
    expect(resolveRequestId(['req_one', 'req_two'])).toMatch(UUID);
  });

  it('generates a different id per call', () => {
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });
});
