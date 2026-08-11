import { describe, expect, it } from 'vitest';
import { readInviteToken } from './invite-token';

describe('readInviteToken', () => {
  it('reads the token the emailed link puts in the fragment', () => {
    expect(readInviteToken('#token=a-256-bit-token')).toBe('a-256-bit-token');
  });

  it('accepts a fragment that has already had its leading hash stripped', () => {
    expect(readInviteToken('token=a-256-bit-token')).toBe('a-256-bit-token');
  });

  it('decodes a token carrying base64url padding', () => {
    expect(readInviteToken('#token=abc%3D%3D')).toBe('abc==');
  });

  it('ignores anything else riding along in the fragment', () => {
    expect(readInviteToken('#foo=bar&token=a-256-bit-token')).toBe('a-256-bit-token');
  });

  it('answers null for a link that lost its fragment', () => {
    expect(readInviteToken('')).toBeNull();
    expect(readInviteToken('#')).toBeNull();
    expect(readInviteToken('#token=')).toBeNull();
    expect(readInviteToken('#other=value')).toBeNull();
  });
});
