import { describe, expect, it } from 'vitest';
import { content } from '@/content/en';
import { testBranding } from '@/lib/testing/branding';
import {
  accentReadout,
  brandingDraftFrom,
  brandingUpdateFrom,
  hasBrandingErrors,
  previewBrandingFrom,
  validateBrandingDraft,
  type BrandingDraft,
} from './branding-draft';

function draft(overrides: Partial<BrandingDraft> = {}): BrandingDraft {
  return {
    productName: 'Northwind Support',
    supportEmail: 'help@northwind.example',
    primaryColor: '#0f6fde',
    accentColor: '#7c3aed',
    ...overrides,
  };
}

describe('brandingUpdateFrom', () => {
  it('sends null for a cleared support email rather than an empty string', () => {
    // The column is nullable and the schema refuses `''`, so an empty string
    // would fail validation on a field the user deliberately cleared.
    expect(brandingUpdateFrom(draft({ supportEmail: '   ' })).supportEmail).toBeNull();
  });

  it('trims the product name and lower-cases the colours', () => {
    const update = brandingUpdateFrom(draft({ productName: '  Acme  ', primaryColor: '#B3261E' }));

    expect(update.productName).toBe('Acme');
    expect(update.primaryColor).toBe('#b3261e');
  });
});

describe('validateBrandingDraft', () => {
  it('accepts a complete draft', () => {
    expect(hasBrandingErrors(validateBrandingDraft(draft(), content.branding))).toBe(false);
  });

  it('accepts an empty support email — it is optional', () => {
    const errors = validateBrandingDraft(draft({ supportEmail: '' }), content.branding);

    expect(errors.supportEmail).toBeUndefined();
  });

  it('refuses a blank product name, a bad address and a half-typed colour', () => {
    const errors = validateBrandingDraft(
      draft({ productName: '  ', supportEmail: 'not-an-address', primaryColor: '#0f6' }),
      content.branding,
    );

    expect(errors.productName).toBe(content.branding.productNameRequired);
    expect(errors.supportEmail).toBe(content.branding.supportEmailInvalid);
    expect(errors.primaryColor).toBe(content.branding.colorInvalid);
  });
});

describe('previewBrandingFrom', () => {
  const saved = testBranding({ primaryColor: '#067a52', productName: 'Saved name' });

  it('falls back to the saved colour while one is being typed', () => {
    // Not to the platform default: the preview would flash green every time
    // somebody cleared the field to paste a new hex.
    expect(previewBrandingFrom(draft({ primaryColor: '#0f6' }), saved).primaryColor).toBe(
      '#067a52',
    );
  });

  it('shows the draft colour as soon as it is a colour', () => {
    expect(previewBrandingFrom(draft({ primaryColor: '#B3261E' }), saved).primaryColor).toBe(
      '#b3261e',
    );
  });

  it('keeps the saved assets — they are set by their own routes', () => {
    const withLogo = testBranding({
      logo: {
        path: '/api/v1/tenant/branding/logo?v=1',
        mimeType: 'image/png',
        sizeBytes: 1024,
        updatedAt: '2026-08-12T12:00:00.000Z',
      },
    });

    expect(previewBrandingFrom(draft(), withLogo).logo).toEqual(withLogo.logo);
  });
});

describe('accentReadout', () => {
  it('says nothing while the value is not a colour yet', () => {
    // A score of 1:1 for a half-typed hex reads as a verdict.
    expect(accentReadout('#0f6')).toBeNull();
  });

  it('reports "not adjusted" for a colour white text already clears', () => {
    expect(accentReadout('#05613f')?.isAdjusted).toBe(false);
  });

  it('reports "adjusted" for a colour that needed dark text', () => {
    // A pale yellow: perfectly usable, but only because the console switched the
    // label to dark rather than because white worked.
    expect(accentReadout('#fef08a')?.isAdjusted).toBe(true);
  });

  it('always reports a passing ratio, because the correction guarantees one', () => {
    for (const colour of ['#fef08a', '#767676', '#000000', '#ffffff', '#0f6fde']) {
      expect(accentReadout(colour)?.ratio).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('brandingDraftFrom', () => {
  it('turns a null support email into the empty control value', () => {
    expect(brandingDraftFrom(testBranding({ supportEmail: null })).supportEmail).toBe('');
  });
});
