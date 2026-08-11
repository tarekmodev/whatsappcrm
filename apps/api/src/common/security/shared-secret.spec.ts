import { matchesSharedSecret } from './shared-secret';

const SECRET = 'e'.repeat(64);

describe('matchesSharedSecret', () => {
  it('accepts the secret it was given', () => {
    expect(matchesSharedSecret(SECRET, SECRET)).toBe(true);
  });

  it.each([
    ['a different secret of the same length', 'f'.repeat(64)],
    ['a prefix of it', SECRET.slice(0, 32)],
    ['it with one character changed', `${SECRET.slice(0, 63)}f`],
    ['an empty string', ''],
  ])('refuses %s', (_label, presented) => {
    expect(matchesSharedSecret(presented, SECRET)).toBe(false);
  });

  it('does not throw on a length mismatch, which would leak the expected length', () => {
    // The reason both sides are hashed first: `timingSafeEqual` throws when the
    // buffers differ in length, and that error is observable.
    expect(() => matchesSharedSecret('a', SECRET)).not.toThrow();
  });
});
