import type { TenantBranding } from '@whatsappcrm/contracts';
import { useContent } from '@/lib/content';
import styles from './AuthBrandPanel.module.css';

/**
 * The half of a signed-out screen that is not the form. Usage:
 * `<AuthBrandPanel branding={branding} />` from the `(auth)` layout.
 *
 * It carries the product's name at display size, one line of positioning, and a
 * geometric treatment built from the tokens a tenant already owns. Not
 * photography and not an illustration: this panel renders under whatever brand
 * the request host resolves to, and a stock image chosen for the platform would
 * be somebody else's identity on somebody else's sign-in page.
 *
 * ## Where the name comes from
 *
 * `branding`, resolved from the host by `readBranding` and passed down — the same
 * value the lockup, the document title and the accent tokens are built from. This
 * component holds no fallback of its own: `withBrandingDefaults` has already
 * decided what an unbranded tenant is called, and a second answer here would be a
 * second place for white-labelling to be wrong (TAR-29).
 *
 * ## Why the whole panel is hidden from assistive technology
 *
 * The name is already on the page, as the lockup above the form, where it is the
 * accessible name of the product for a screen-reader user. Exposing it again here
 * would announce the workspace twice before the heading — so the panel is
 * decoration in the accessibility tree, and the copy in it is for the eye.
 *
 * ## Below 64rem
 *
 * It renders nothing: the module file drops it, and the lockup band at the top of
 * the form panel is what carries the brand at that width. A tagline and a display
 * heading above a form on a 390px screen is two screens of scrolling before the
 * first field.
 */
export function AuthBrandPanel({ branding }: { branding: TenantBranding }) {
  const content = useContent();

  return (
    <div className={styles.panel} aria-hidden="true">
      <div className={styles.statement}>
        <p className={styles.name}>{branding.productName}</p>
        <p className={styles.tagline}>{content.auth.brandTagline}</p>
      </div>
      {/*
        Three shapes from the same vocabulary the rest of the console is drawn
        with — a disc, a ring and a rounded square on the radius scale. They sit
        in their own row below the copy rather than behind it, which is what keeps
        `--color-brand-decor` off the text: the tenant picks that colour, and a
        contrast guarantee cannot be made about a colour somebody else chooses.
      */}
      <div className={styles.decor}>
        <span className={styles.disc} />
        <span className={styles.ring} />
        <span className={styles.square} />
      </div>
    </div>
  );
}
