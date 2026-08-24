import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BRAND_TOKEN_NAMES } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { testBranding } from '@/lib/testing/branding';
import { BrandingPreview } from './BrandingPreview';

/**
 * The preview's only real property, and the one its label promises: **it renders
 * the same way the console does**. `content.branding.previewDescription` says so
 * in as many words — "Live, and exactly what the console will use once you save."
 *
 * That used to be true because both sides called `brandCssVariables`. It stopped
 * being true when `brandStyleSheet` gained its default-colours early return
 * (TAR-801), and the divergence was invisible: the preview kept deriving one
 * accent for both themes while the console drew the token layer's per-theme pair,
 * so a dark-mode link sample rendered at 3.00:1 beside a console rendering that
 * same role at 6.35:1.
 *
 * So these assert the *branch*, not the values — whether the panel carries its own
 * custom properties at all is exactly what has to match `brandStyleSheet`.
 */

function panel() {
  return screen.getByRole('group', { name: content.branding.previewHeading });
}

describe('BrandingPreview', () => {
  describe('a tenant still on the platform colours', () => {
    it('sets no custom properties, so it inherits the cascade the console uses', () => {
      render(<BrandingPreview branding={testBranding()} theme="light" />);

      expect(panel()).not.toHaveAttribute('style');
    });

    it('does the same in the dark theme, where the two used to disagree most', () => {
      render(<BrandingPreview branding={testBranding()} theme="dark" />);

      expect(panel()).not.toHaveAttribute('style');
    });
  });

  describe('a tenant who has chosen a colour', () => {
    it('declares every tenant-owned token, so the sample is that colour', () => {
      render(
        <BrandingPreview branding={testBranding({ primaryColor: '#b3261e' })} theme="light" />,
      );

      const style = panel().getAttribute('style') ?? '';

      for (const token of BRAND_TOKEN_NAMES) {
        expect(style, `${token} is missing from the preview`).toContain(`${token}:`);
      }
      expect(style).toContain('--color-accent: #b3261e');
    });

    /*
     * The decorative colour alone is enough. It is the token that has no
     * consumer in the accent derivation, so a branch keyed only on the primary
     * would silently drop it — which is the shape of the bug this file exists for.
     */
    it('counts a custom decorative colour as chosen, not only the primary', () => {
      render(<BrandingPreview branding={testBranding({ accentColor: '#7c3aed' })} theme="light" />);

      expect(panel().getAttribute('style') ?? '').toContain('--color-brand-decor: #7c3aed');
    });
  });
});
