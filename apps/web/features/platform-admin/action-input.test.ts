import { describe, expect, it } from 'vitest';
import { PlatformCredentialParser, SuspendTenantInputParser } from './action-input';

describe('SuspendTenantInputParser', () => {
  it('takes a slug and a reason', () => {
    const parsed = SuspendTenantInputParser.safeParse({
      slug: 'northwind',
      reason: 'fraud, card chargeback',
    });

    expect(parsed).toEqual({
      success: true,
      data: { slug: 'northwind', reason: 'fraud, card chargeback' },
    });
  });

  /**
   * The field is optional and an operator acting on an incident must not be
   * blocked by one — but `DeactivateTenantInputSchema` requires at least one
   * character when the key is present, so an untouched box has to be dropped
   * rather than sent as `''`.
   */
  it.each(['', '   '])('drops a reason of %j rather than refusing the submit', (reason) => {
    const parsed = SuspendTenantInputParser.safeParse({ slug: 'northwind', reason });

    expect(parsed).toEqual({ success: true, data: { slug: 'northwind' } });
  });

  it('trims a reason it does keep', () => {
    const parsed = SuspendTenantInputParser.safeParse({ slug: 'northwind', reason: '  why  ' });

    expect(parsed.success && parsed.data.reason).toBe('why');
  });

  /** The slug is the contract's, so a value this accepts cannot come back a 400. */
  it.each(['Northwind', 'no', '-leading', 'trailing-', 'has space', ''])(
    'refuses %j, which the slug schema refuses',
    (slug) => {
      expect(SuspendTenantInputParser.safeParse({ slug }).success).toBe(false);
    },
  );

  it('refuses a reason past the contract’s limit', () => {
    const parsed = SuspendTenantInputParser.safeParse({
      slug: 'northwind',
      reason: 'x'.repeat(501),
    });

    expect(parsed.success).toBe(false);
  });

  it.each([null, undefined, 'northwind', 42])(
    'refuses %j, which is not an input object',
    (value) => {
      expect(SuspendTenantInputParser.safeParse(value).success).toBe(false);
    },
  );
});

describe('PlatformCredentialParser', () => {
  /**
   * A pasted secret routinely carries a trailing newline, and a credential that
   * failed for that reason would be indistinguishable from a wrong one.
   */
  it('trims the surrounding whitespace a paste brings with it', () => {
    expect(PlatformCredentialParser.safeParse('  secret\n')).toEqual({
      success: true,
      data: 'secret',
    });
  });

  it.each(['', '   ', undefined, null, 42])('refuses %j', (value) => {
    expect(PlatformCredentialParser.safeParse(value).success).toBe(false);
  });

  /**
   * Emptiness and nothing else. `PlatformAdminGuard` answers one refusal for an
   * absent header, a wrong scheme, a wrong token and an unconfigured
   * environment, so a shape check here would hand back the distinction that
   * refusal exists to withhold.
   */
  it('accepts a value of any shape, because the console must not narrow the guess', () => {
    expect(PlatformCredentialParser.safeParse('x').success).toBe(true);
    expect(PlatformCredentialParser.safeParse('label:looks-like-an-entry').success).toBe(true);
  });
});
