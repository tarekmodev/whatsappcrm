import { generateAuthToken, hashAuthToken } from './auth-tokens';

/**
 * The two properties every invite, reset and session token rests on: enough
 * entropy that guessing is not a strategy, and a digest at rest so a database
 * dump is not a set of live credentials.
 */
describe('auth tokens', () => {
  it('carries 256 bits of entropy in a URL-safe form', () => {
    const token = generateAuthToken();

    // 32 bytes, base64url, unpadded.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, generateAuthToken));

    expect(tokens.size).toBe(500);
  });

  it('hashes to a stable SHA-256 hex digest that is not the token', () => {
    const token = generateAuthToken();
    const digest = hashAuthToken(token);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
    expect(hashAuthToken(token)).toBe(digest);
  });

  it('gives different tokens different digests', () => {
    expect(hashAuthToken(generateAuthToken())).not.toBe(hashAuthToken(generateAuthToken()));
  });
});
