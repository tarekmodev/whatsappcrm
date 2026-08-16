import { describe, expect, it } from 'vitest';
import { BRAND_TOKEN_NAMES } from '@whatsappcrm/contracts';
import { brandStyleSheet } from './brand-style';
import { testBranding } from '@/lib/testing/branding';

/**
 * The block the root layout emits. What matters is not the exact text but three
 * properties, each of which is a way white-labelling silently stops working:
 *
 *   1. the selectors outrank `semantic.css`, so the cascade does not depend on
 *      where the bundler happens to put this block;
 *   2. the dark rule wins in dark mode, so the light rule's higher specificity
 *      does not leak across the theme boundary;
 *   3. only the seven tenant-owned names appear — a platform token in here would
 *      let a tenant repaint an error state.
 */

const SHEET = brandStyleSheet(testBranding({ primaryColor: '#0f6fde', accentColor: '#7c3aed' }));

describe('brandStyleSheet', () => {
  it('outranks the platform token layer in both themes', () => {
    // `semantic.css` declares `:root, [data-theme='light']` and
    // `[data-theme='dark']`, all 0-1-0. These are 0-2-0.
    expect(SHEET).toContain(":root:not([data-theme='dark']){");
    expect(SHEET).toContain(":root[data-theme='dark']{");
  });

  it('puts the dark rule after the light one, so dark mode wins the tie', () => {
    expect(SHEET.indexOf(":root[data-theme='dark']")).toBeGreaterThan(
      SHEET.indexOf(":root:not([data-theme='dark'])"),
    );
  });

  it('declares every tenant-owned token in each theme', () => {
    for (const token of BRAND_TOKEN_NAMES) {
      // Once per theme block.
      expect(SHEET.split(`${token}:`)).toHaveLength(3);
    }
  });

  it('declares no platform-owned token', () => {
    const declared = [...SHEET.matchAll(/(--[a-z-]+):/g)].map((match) => match[1]);

    // A tenant may not repaint a surface, a status or a border. Anything outside
    // the published seven would let them.
    expect(new Set(declared)).toEqual(new Set(BRAND_TOKEN_NAMES));
  });

  it('emits concrete hex only, so a single test can assert every pair', () => {
    // No `color-mix`, no `var()`: a value the browser derives is a value no
    // contrast test can check.
    expect(SHEET).not.toContain('var(');
    expect(SHEET).not.toContain('color-mix');
  });

  it('carries the tenant’s own colours through', () => {
    expect(SHEET).toContain('--color-accent:#0f6fde');
    expect(SHEET).toContain('--color-brand-decor:#7c3aed');
  });
});
