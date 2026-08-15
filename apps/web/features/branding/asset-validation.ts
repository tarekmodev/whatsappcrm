import { BRANDING_ASSET_LIMITS, type BrandingAssetKind } from '@whatsappcrm/contracts';

/**
 * The client-side half of the branding upload check.
 *
 * It exists to refuse a 4 MB PNG *before* the upload is spent, not to be the
 * enforcement: the API applies the same `BRANDING_ASSET_LIMITS` again and sniffs
 * the real content type rather than trusting the browser's. Both halves read the
 * one published constant, so they cannot drift into telling a user two different
 * things about the same file.
 */

export const ASSET_REJECTIONS = ['too_large', 'wrong_type'] as const;
export type AssetRejection = (typeof ASSET_REJECTIONS)[number];

/**
 * `null` when the file is acceptable.
 *
 * Type before size, because "that is not a PNG" is the more useful of the two
 * answers when a file fails both — being told to shrink a PDF sends somebody to
 * an image compressor for nothing.
 */
export function rejectBrandingAsset(kind: BrandingAssetKind, file: File): AssetRejection | null {
  const limits = BRANDING_ASSET_LIMITS[kind];

  if (!limits.mimeTypes.includes(file.type)) {
    return 'wrong_type';
  }

  if (file.size > limits.maxBytes) {
    return 'too_large';
  }

  return null;
}

/** The `accept` attribute for this kind's file input, from the same source. */
export function brandingAcceptAttribute(kind: BrandingAssetKind): string {
  return BRANDING_ASSET_LIMITS[kind].mimeTypes.join(',');
}
