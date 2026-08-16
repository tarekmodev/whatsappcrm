import { withBrandingDefaults, type TenantBranding } from '@whatsappcrm/contracts';

/**
 * A branding record for tests, defaulted from the contract's own filler so a
 * field added to `TenantBrandingSchema` cannot leave call sites half-built.
 *
 * `logo` and `favicon` default to `null` — the state every tenant starts in, and
 * the one the wordmark fallback is for. Pass one explicitly to exercise the
 * image path.
 */
export function testBranding(overrides: Partial<TenantBranding> = {}): TenantBranding {
  return { ...withBrandingDefaults(null), ...overrides };
}
