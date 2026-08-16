import type { TenantBranding } from '@whatsappcrm/contracts';
import { useContent } from '@/lib/content';
import styles from './BrandLogo.module.css';

/**
 * The tenant's uploaded logo, or nothing. Usage:
 * `{branding.logo === null ? <Wordmark/> : <BrandLogo branding={branding} />}`.
 *
 * It returns `null` rather than a placeholder when no logo is set, so each call
 * site keeps its own wordmark fallback — the rail's is an initial plus a name,
 * the sign-in screen's is a centred line of text, and neither belongs in a shared
 * component.
 *
 * ## Why a plain `<img>` and a fixed box
 *
 * `next/image` wants intrinsic dimensions or a `fill` parent, and the branding
 * contract publishes a logo's bytes, type and size but **not its width and
 * height** — so there is nothing to hand it, and pointing the optimiser at a
 * per-tenant, session-scoped API route would proxy every tenant's asset through
 * the image pipeline for no gain. The one thing `next/image` buys that matters
 * here is a reserved box, and that is what the module file does explicitly: both
 * axes fixed, `object-fit: contain`, so a tall logo and a wide one both letterbox
 * inside the same space and neither shifts the layout when it decodes.
 *
 * The `src` is a **relative** path (`/api/v1/tenant/branding/logo?v=…`), so it is
 * fetched first-party under a custom domain and carries the same host — and
 * therefore the same tenant — as the page it is on.
 */

export interface BrandLogoProps {
  branding: TenantBranding;
  /** `lg` above the sign-in form, where there is room; `md` in the app chrome. */
  size?: 'md' | 'lg';
  /**
   * The logo usually sits inside a link that already names the destination, so
   * it is decorative by default and takes an empty `alt`. Standalone — the
   * sign-in screen — it is the only thing naming the workspace, so it gets one.
   */
  isDecorative?: boolean;
}

export function BrandLogo({ branding, size = 'md', isDecorative = true }: BrandLogoProps) {
  const content = useContent();

  if (branding.logo === null) {
    return null;
  }

  return (
    /*
     * `next/image` would route this through the optimizer, whose cache is keyed
     * on the src URL — and this URL is *identical for every tenant*, because the
     * tenant is the host. That is the cross-tenant leak this whole feature
     * exists to avoid. The one thing the component would buy here is a reserved
     * box, and the module file does that explicitly.
     */
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={styles.logo}
      data-size={size}
      src={branding.logo.path}
      alt={isDecorative ? '' : content.branding.assetAlt(branding.productName)}
      // Above the fold in every place it appears — it is chrome, not content.
      loading="eager"
      decoding="async"
    />
  );
}
