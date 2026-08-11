import { createSessionToken, hashSessionToken, SESSION_TOKEN_BYTES } from './session-token';

/**
 * The two properties that matter about a session credential: it is
 * unguessable, and the database never holds the thing that opens the door.
 */
describe('session tokens', () => {
  it('is 256 bits, encoded so it survives a Set-Cookie header untouched', () => {
    const token = createSessionToken();

    // 32 bytes → 43 base64url characters, unpadded.
    expect(token).toHaveLength(Math.ceil((SESSION_TOKEN_BYTES * 8) / 6));
    // No `+`, `/` or `=`: all three need escaping somewhere between the header
    // and a URL, and a token that survives one hop and not the next is a bug
    // that only shows up in one browser.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 1_000 }, () => createSessionToken()));

    // A duplicate here would mean the generator is not what it claims to be —
    // a collision at 256 bits does not happen by chance in a thousand draws.
    expect(tokens.size).toBe(1_000);
  });

  it('stores a hash, and one that cannot be read back to the token', () => {
    const token = createSessionToken();
    const hash = hashSessionToken(token);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('hashes deterministically, which is what makes the lookup an index hit', () => {
    const token = createSessionToken();

    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toBe(hashSessionToken(createSessionToken()));
  });
});
