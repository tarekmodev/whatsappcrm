import type { ReactNode } from 'react';
import { withBrandingDefaults } from '@whatsappcrm/contracts';
import { readTheme } from '@/lib/theme/read-theme';
import { BrandLockup } from '@/components/brand/BrandLockup';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import styles from './layout.module.css';

/**
 * The credential screen's frame: a band with the platform's lockup, `<main>` with
 * the screen's single `<h1>` in it, and the theme control.
 *
 * No navigation and no skip link — there is nothing to skip past, and an operator
 * who has not presented a token has no destination to be offered.
 *
 * ## The lockup is the platform's, never the host's tenant
 *
 * `withBrandingDefaults(null)` rather than `readBranding()`, and this is the one
 * screen where that distinction is load-bearing enough to state twice. Branding
 * is resolved from the request host, so an operator who opens this console on a
 * customer's white-label domain would be shown that customer's logo above a form
 * that authenticates them for *every* tenant on the platform. Dressing the
 * control plane as one customer's product is the one place white-labelling would
 * actively mislead the person reading it.
 *
 * It also costs nothing: the platform defaults are a pure function of `null`, so
 * this screen makes no branding round-trip at all.
 */
export default async function PlatformAdminGateLayout({ children }: { children: ReactNode }) {
  const theme = await readTheme();
  const platform = withBrandingDefaults(null);

  return (
    <div className={styles.layout}>
      <header className={styles.band}>
        {/*
          Not decorative: this is the only accessible spelling of the product's
          name on the screen, and there is no link around it to name it instead —
          an operator with no credential has nowhere to be sent.
        */}
        <BrandLockup branding={platform} size="lg" isDecorative={false} />
      </header>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className={styles.content}>
        <div className={styles.column}>{children}</div>
      </main>
      <div className={styles.footer}>
        <ThemeToggle initialTheme={theme} isLabelVisible />
      </div>
    </div>
  );
}
