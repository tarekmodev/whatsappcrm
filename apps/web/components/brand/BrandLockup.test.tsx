import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { testBranding } from '@/lib/testing/branding';
import { BrandLockup } from './BrandLockup';

/**
 * The lockup the top bar, the drawer and the signed-out screens all render
 * (TAR-522, TAR-521). What matters is that it is the tenant's identity in every
 * case, that it never announces itself twice, and that the signed-out copy does
 * not offer a destination a signed-out visitor cannot reach.
 */

const PRODUCT_NAME = 'Northwind Support';
const LOGO = {
  path: '/api/v1/tenant/branding/logo?v=1',
  mimeType: 'image/png',
  sizeBytes: 1024,
  updatedAt: '2026-08-22T00:00:00.000Z',
};

describe('BrandLockup', () => {
  it('links home and names the workspace, for the chrome', () => {
    render(<BrandLockup branding={testBranding({ productName: PRODUCT_NAME })} />);

    expect(screen.getByRole('link', { name: PRODUCT_NAME })).toHaveAttribute('href', '/inbox');
  });

  it('hands the whole lockup over to a tenant that has uploaded a logo', () => {
    const branding = testBranding({ productName: PRODUCT_NAME, logo: LOGO });

    render(<BrandLockup branding={branding} />);

    // Decorative: the link around it already names the destination, so a second
    // name would say the workspace twice.
    expect(screen.getByRole('presentation')).toHaveAttribute('alt', '');
    expect(screen.getByRole('link', { name: PRODUCT_NAME })).toBeInTheDocument();
  });

  it('offers no destination where there is nowhere a signed-out visitor may go', () => {
    render(<BrandLockup branding={testBranding({ productName: PRODUCT_NAME })} isLinked={false} />);

    expect(screen.queryByRole('link')).toBeNull();
    // The wordmark is the name now, because there is no link to carry it.
    expect(screen.getByText(PRODUCT_NAME)).toBeInTheDocument();
  });

  it('gives a standalone logo the text alternative the missing link took with it', () => {
    const branding = testBranding({ productName: PRODUCT_NAME, logo: LOGO });

    render(<BrandLockup branding={branding} size="lg" isLinked={false} />);

    expect(screen.getByRole('img')).toHaveAccessibleName(content.branding.assetAlt(PRODUCT_NAME));
  });
});
