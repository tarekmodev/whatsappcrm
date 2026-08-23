import { describe, expect, it } from 'vitest';
import {
  BRAND_THEMES,
  BRAND_TOKEN_NAMES,
  brandCssVariables,
  contrastRatio,
  onAccentFor,
  withBrandingDefaults,
  type BrandTheme,
} from './branding-theme';
import { BRANDING_DEFAULTS, type TenantBranding } from './tenant';

/**
 * The accessibility guarantee, asserted as a property rather than on a handful of
 * pleasant colours.
 *
 * A tenant picks the accent, so the interesting inputs are the ones nobody would
 * choose on purpose: pale yellow, mid grey, the exact luminance band where both
 * white and `slate-950` fall just under 4.5:1. The sweep below is what stops that
 * band shipping — it is not a formality, it is the reason the derivation is a
 * function instead of three `color-mix` declarations.
 */

const AA_TEXT = 4.5;
const FOCUS_INDICATOR = 3;

/** Canvas per theme, mirroring `styles/tokens/semantic.css`. */
const CANVAS: Record<BrandTheme, string> = { light: '#f6f7f9', dark: '#0e1117' };

function branding(primaryColor: string, accentColor = '#2e4a63'): TenantBranding {
  return withBrandingDefaults({ primaryColor, accentColor });
}

/**
 * A grid over the hex space plus the awkward greys.
 *
 * Step 17 rather than 16 so the samples are not all multiples of a power of two —
 * a grid aligned to the channel encoding is a grid that can miss a band that sits
 * between its lines.
 */
function* sweep(): Generator<string> {
  for (let r = 0; r <= 255; r += 17) {
    for (let g = 0; g <= 255; g += 51) {
      for (let b = 0; b <= 255; b += 51) {
        yield `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      }
    }
  }

  // The mid-luminance run, one step at a time: this is where `#ffffff` and
  // `#020617` both fall short and only `#000000` clears AA.
  for (let value = 100; value <= 190; value += 1) {
    const channel = value.toString(16).padStart(2, '0');

    yield `#${channel}${channel}${channel}`;
  }
}

describe('brandCssVariables', () => {
  it('emits exactly the seven tenant-owned tokens, and no platform token', () => {
    const tokens = brandCssVariables(branding('#067a52'), 'light');

    expect(Object.keys(tokens).sort()).toEqual([...BRAND_TOKEN_NAMES].sort());
  });

  it('emits concrete hex, never a color-mix or a var() reference', () => {
    for (const theme of BRAND_THEMES) {
      for (const value of Object.values(brandCssVariables(branding('#8b5cf6'), theme))) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('passes the tenant colours through untouched', () => {
    const tokens = brandCssVariables(branding('#B3261E', '#1D4ED8'), 'light');

    // Lower-cased, so two spellings of one colour produce one token value.
    expect(tokens['--color-accent']).toBe('#b3261e');
    expect(tokens['--color-brand-decor']).toBe('#1d4ed8');
  });

  it('clears AA on every derived text pair, for every accent, in both themes', () => {
    for (const primaryColor of sweep()) {
      for (const theme of BRAND_THEMES) {
        const tokens = brandCssVariables(branding(primaryColor), theme);

        expect(
          contrastRatio(tokens['--color-on-accent'], tokens['--color-accent']),
          `on-accent over ${primaryColor} (${theme})`,
        ).toBeGreaterThanOrEqual(AA_TEXT);

        expect(
          contrastRatio(tokens['--color-on-accent-subtle'], tokens['--color-accent-subtle']),
          `on-accent-subtle over ${primaryColor} (${theme})`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it('clears SC 1.4.11 on the focus ring against the canvas, for every accent', () => {
    for (const primaryColor of sweep()) {
      for (const theme of BRAND_THEMES) {
        const tokens = brandCssVariables(branding(primaryColor), theme);

        expect(
          contrastRatio(tokens['--color-focus-ring'], CANVAS[theme]),
          `focus ring over the ${theme} canvas for ${primaryColor}`,
        ).toBeGreaterThanOrEqual(FOCUS_INDICATOR);
      }
    }
  });

  it('moves hover away from the canvas in each theme, so it reads as more of the same colour', () => {
    const accent = '#4f8ef7';

    // Light: darker than the accent. Dark: lighter. The token names are identical;
    // only the values differ, which is what keeps components theme-blind.
    expect(
      contrastRatio(
        brandCssVariables(branding(accent), 'light')['--color-accent-hover'],
        '#ffffff',
      ),
    ).toBeGreaterThan(contrastRatio(accent, '#ffffff'));
    expect(
      contrastRatio(brandCssVariables(branding(accent), 'dark')['--color-accent-hover'], '#ffffff'),
    ).toBeLessThan(contrastRatio(accent, '#ffffff'));
  });

  it('refuses a colour that is not #rrggbb rather than falling back to black', () => {
    expect(() => brandCssVariables(branding('rgb(1 2 3)'), 'light')).toThrow(RangeError);
  });
});

describe('onAccentFor', () => {
  it('reaches for pure black in the band where white and slate-950 both fall short', () => {
    // ~0.184 relative luminance: sqrt(20.17) is 4.49, so `#020617` cannot clear
    // AA here and neither can white. Without the third candidate this returns a
    // failing pair.
    const awkward = '#767676';

    expect(contrastRatio(onAccentFor(awkward), awkward)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('is a real choice, not always white', () => {
    expect(onAccentFor('#f8fafc')).not.toBe('#ffffff');
    expect(onAccentFor('#05613f')).toBe('#ffffff');
  });
});

describe('withBrandingDefaults', () => {
  it('fills an absent branding record so the shell renders like the platform', () => {
    expect(withBrandingDefaults(null)).toEqual({
      productName: BRANDING_DEFAULTS.productName,
      primaryColor: BRANDING_DEFAULTS.primaryColor,
      accentColor: BRANDING_DEFAULTS.accentColor,
      supportEmail: null,
      logo: null,
      favicon: null,
    });
  });

  it('keeps every value the tenant did set', () => {
    expect(withBrandingDefaults({ productName: 'Acme Support' }).productName).toBe('Acme Support');
    expect(withBrandingDefaults({ productName: 'Acme Support' }).primaryColor).toBe(
      BRANDING_DEFAULTS.primaryColor,
    );
  });
});
