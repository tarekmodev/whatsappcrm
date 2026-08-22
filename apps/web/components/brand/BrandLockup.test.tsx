import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { testBranding } from '@/lib/testing/branding';
import { BrandLockup } from './BrandLockup';

/**
 * The one lockup the rail, the top bar and the signed-out screens all render
 * (TAR-521). What matters is that it is the tenant's identity in every case and
 * that it never announces itself twice.
 */

const PRODUCT_NAME = 'Northwind Support';
const LOGO = {
  path: '/api/v1/tenant/branding/logo?v=1',
  mimeType: 'image/png',
  sizeBytes: 1024,
  updatedAt: '2026-08-22T00:00:00.000Z',
};

describe('BrandLockup', () => {
  it('spells an unbranded tenant as its initial beside its name', () => {
    render(<BrandLockup branding={testBranding({ productName: PRODUCT_NAME })} />);

    expect(screen.getByText(PRODUCT_NAME)).toBeInTheDocument();
    // The initial is the first letter of the word beside it, so it is decoration
    // rather than a second thing to read out.
    expect(screen.getByText('N')).toHaveAttribute('aria-hidden', 'true');
  });

  it('takes a whole first character, not half of a surrogate pair', () => {
    render(<BrandLockup branding={testBranding({ productName: '𝒜cme' })} />);

    expect(screen.getByText('𝒜')).toBeInTheDocument();
  });

  it('hands the whole lockup over to a tenant that has uploaded a logo', () => {
    const branding = testBranding({
      productName: PRODUCT_NAME,
      logo: LOGO,
    });

    render(<BrandLockup branding={branding} isDecorative={false} />);

    // No initial-in-a-square beside somebody else's mark.
    expect(screen.queryByText('N')).toBeNull();
    expect(screen.getByRole('img')).toHaveAccessibleName(content.branding.assetAlt(PRODUCT_NAME));
  });

  it('is silent where the link around it already names the destination', () => {
    const branding = testBranding({
      productName: PRODUCT_NAME,
      logo: LOGO,
    });

    render(<BrandLockup branding={branding} />);

    expect(screen.getByRole('presentation')).toHaveAttribute('alt', '');
  });
});
