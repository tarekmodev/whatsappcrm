import type { ReactNode } from 'react';
import { withBrandingDefaults } from '@whatsappcrm/contracts';
import { BrandLockup } from '@/components/brand/BrandLockup';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';
import { content } from '~/content/en';
import styles from './layout.module.css';

/**
 * The credential screen's frame: 0001's signed-out split, with the brand panel
 * carrying the **platform's** identity (spec §2.2).
 *
 * No navigation and no skip link — there is nothing to skip past, and an operator
 * who has not presented a token has no destination to be offered. No theme
 * control either: this console has one theme (see the root layout).
 *
 * `withBrandingDefaults(null)` rather than `readBranding()`, and on this screen
 * the distinction is worth stating twice. Branding is resolved from the request
 * host, so a console opened on a customer's white-label domain would show that
 * customer's logo above a form that authenticates the operator for *every* tenant
 * on the platform. It also costs nothing: the defaults are a pure function of
 * `null`, so this screen makes no branding round-trip at all.
 */
export default function CredentialLayout({ children }: { children: ReactNode }) {
  const platform = withBrandingDefaults(null);

  return (
    <div className={styles.layout}>
      <div className={styles.formPanel}>
        {/*
          Not decorative: this is the only accessible spelling of the product's
          name on the screen, and there is no link around it to name it instead —
          an operator with no credential has nowhere to be sent.
        */}
        <header className={styles.band}>
          <BrandLockup branding={platform} size="lg" isDecorative={false} />
        </header>
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className={styles.content}>
          <div className={styles.column}>{children}</div>
        </main>
      </div>
      {/* Decoration: the band above already names the product to a screen reader. */}
      <aside className={styles.brandPanel} aria-hidden="true">
        <p className={styles.brandName}>{content.app.name}</p>
        <p className={styles.brandStatement}>{content.credential.brandStatement}</p>
      </aside>
    </div>
  );
}
