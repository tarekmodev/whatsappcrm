import { describe, expect, it } from 'vitest';
import { BRANDING_ASSET_LIMITS } from '@whatsappcrm/contracts';
import { brandingAcceptAttribute, rejectBrandingAsset } from './asset-validation';

function fileOf(type: string, size: number): File {
  const file = new File(['x'], 'logo', { type });

  // `File` has no writable size, and building a megabyte of real bytes for a
  // limit check would make the suite slow for nothing.
  Object.defineProperty(file, 'size', { value: size });

  return file;
}

describe('rejectBrandingAsset', () => {
  it('accepts a file inside both limits', () => {
    expect(rejectBrandingAsset('logo', fileOf('image/png', 1024))).toBeNull();
  });

  it('refuses a file over the published cap', () => {
    const oversize = BRANDING_ASSET_LIMITS.logo.maxBytes + 1;

    expect(rejectBrandingAsset('logo', fileOf('image/png', oversize))).toBe('too_large');
  });

  it('refuses SVG, which is the one image type that can carry script', () => {
    expect(rejectBrandingAsset('logo', fileOf('image/svg+xml', 512))).toBe('wrong_type');
  });

  it('reports the type before the size when a file fails both', () => {
    const oversize = BRANDING_ASSET_LIMITS.logo.maxBytes + 1;

    expect(rejectBrandingAsset('logo', fileOf('application/pdf', oversize))).toBe('wrong_type');
  });

  it('holds the favicon to its own, tighter limits', () => {
    // A WebP is a fine logo and not a favicon; the two kinds do not share a list.
    expect(rejectBrandingAsset('favicon', fileOf('image/webp', 512))).toBe('wrong_type');
    expect(rejectBrandingAsset('logo', fileOf('image/webp', 512))).toBeNull();
  });
});

describe('brandingAcceptAttribute', () => {
  it('offers exactly the types the contract allows', () => {
    expect(brandingAcceptAttribute('favicon')).toBe(
      BRANDING_ASSET_LIMITS.favicon.mimeTypes.join(','),
    );
  });
});
