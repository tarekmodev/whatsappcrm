import { describe, expect, it } from 'vitest';
import { mailto } from './mailto';

describe('mailto', () => {
  it('builds a bare address with no query when there is no subject', () => {
    expect(mailto('help@operator.example')).toBe('mailto:help@operator.example');
  });

  it('encodes a subject, so one containing & or # does not lose half of itself', () => {
    expect(mailto('help@operator.example', 'Connect our WABA & numbers #2')).toBe(
      'mailto:help@operator.example?subject=Connect%20our%20WABA%20%26%20numbers%20%232',
    );
  });

  it('encodes a space as %20, not +, which a mail client would render literally', () => {
    expect(mailto('help@operator.example', 'two words')).not.toContain('+');
  });
});
