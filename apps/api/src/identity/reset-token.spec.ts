import { createHash } from 'node:crypto';
import { hashResetToken, issueResetToken } from './reset-token';

describe('reset tokens', () => {
  it('mints 256 bits of entropy, base64url encoded', () => {
    const { token } = issueResetToken();

    // 32 bytes → 43 base64url characters, unpadded.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('does not repeat itself', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => issueResetToken().token));

    expect(tokens.size).toBe(64);
  });

  it('stores the SHA-256 of the token and never the token', () => {
    const { token, tokenHash } = issueResetToken();

    expect(tokenHash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(tokenHash).toHaveLength(64);
    expect(tokenHash).not.toContain(token);
  });

  it('hashes deterministically, which is what makes the lookup possible', () => {
    const { token, tokenHash } = issueResetToken();

    expect(hashResetToken(token)).toBe(tokenHash);
    expect(hashResetToken(`${token}x`)).not.toBe(tokenHash);
  });
});
