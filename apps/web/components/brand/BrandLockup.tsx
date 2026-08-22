import type { TenantBranding } from '@whatsappcrm/contracts';
import { BrandLogo } from './BrandLogo';
import styles from './BrandLockup.module.css';

/**
 * The product's mark and its name, as one thing. Usage:
 * `<BrandLockup branding={branding} />`, or `size="lg"` above the sign-in form.
 *
 * The three places this product names itself — the rail, the top bar and the
 * signed-out screens — used to spell it three ways: an initial in a square only
 * when the rail was collapsed, a line of plain text in the bar, and a line of
 * green text above the sign-in card. Three spellings of one identity is the
 * thing a lockup exists to stop, so this is the only component any of them uses
 * (TAR-521).
 *
 * ## What it renders
 *
 * A tenant with an uploaded logo gets `BrandLogo` and nothing else: the logo *is*
 * their lockup, and drawing our initial-in-a-square beside it would be putting a
 * second mark on somebody else's brand. A tenant without one gets the initial and
 * the name, built from `Avatar`'s vocabulary — an accent-filled rounded square
 * with a letter in it — because that shape already means "the thing this belongs
 * to" everywhere else in the console.
 *
 * Both halves come from `branding`, which is resolved from the request host, so
 * white-labelling replaces the lockup without any call site changing (TAR-29).
 */

export interface BrandLockupProps {
  branding: TenantBranding;
  /** `lg` on the signed-out screens, where it is the only chrome; `md` elsewhere. */
  size?: 'md' | 'lg';
  /**
   * The rail and the top bar wrap this in a link that already names the
   * destination, so a second name would say the workspace twice. Standing on its
   * own — the sign-in screen — it is the only thing naming the product, and the
   * wordmark (or the logo's `alt`) has to carry that.
   */
  isDecorative?: boolean;
}

export function BrandLockup({ branding, size = 'md', isDecorative = true }: BrandLockupProps) {
  if (branding.logo !== null) {
    return <BrandLogo branding={branding} size={size} isDecorative={isDecorative} />;
  }

  return (
    <span className={styles.lockup} data-size={size}>
      {/* Decorative in every case: it is the first letter of the word beside it,
          and a screen reader reading "N, Northwind Support" is the initial
          announcing itself for nothing. */}
      <span className={styles.mark} aria-hidden="true">
        {/* `Array.from`, not `charAt`: a product name starting with an emoji or an
            astral character would otherwise be cut in half mid-code-point. */}
        {Array.from(branding.productName)[0] ?? ''}
      </span>
      <span className={styles.name}>{branding.productName}</span>
    </span>
  );
}
