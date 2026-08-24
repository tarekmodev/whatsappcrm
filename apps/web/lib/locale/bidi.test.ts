import { describe, expect, it } from 'vitest';
import { isolateLtr, stripBidiIsolates } from './bidi';

/**
 * The isolate is invisible, so the only way to be sure it is the *right*
 * invisible character is to name the code points. U+2066 and U+2069, not the
 * deprecated embedding pair U+202A/U+202C: an embedding still lets the run
 * influence the neutrals around it, which is the half of the problem that puts a
 * full stop on the wrong side of a phone number.
 */
describe('isolateLtr', () => {
  it('wraps the value in a left-to-right isolate', () => {
    expect(isolateLtr('+966501234567')).toBe('⁦+966501234567⁩');
  });

  /*
   * Named rather than compared against a copy of the source: a test that asserts
   * `isolateLtr(x)` equals a literal built from the same two characters passes
   * whatever those characters are. These are the code points the bidi algorithm
   * treats as an isolate, and nothing else does the job.
   */
  it('uses U+2066 and U+2069, not the deprecated embedding pair', () => {
    const wrapped = isolateLtr('x');

    expect(wrapped.codePointAt(0)).toBe(0x2066);
    expect(wrapped.codePointAt(wrapped.length - 1)).toBe(0x2069);
  });

  it('leaves the value itself untouched', () => {
    const value = 'acme.localhost:3000';

    expect(stripBidiIsolates(isolateLtr(value))).toBe(value);
  });

  /*
   * The characters are formatting, not content: a string that already carries
   * them round-trips, so a value passed through twice does not accumulate them
   * in a way that would change what a comparison sees.
   */
  it('round-trips through strip', () => {
    expect(stripBidiIsolates(isolateLtr(isolateLtr('abc')))).toBe('abc');
  });

  it('isolates an empty string without inventing content', () => {
    expect(stripBidiIsolates(isolateLtr(''))).toBe('');
  });
});
