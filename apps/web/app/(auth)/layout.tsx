import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { readTheme } from '@/lib/theme/read-theme';
import { readBranding } from '@/lib/branding/read-branding';
import { BrandLockup } from '@/components/brand/BrandLockup';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';
import { AuthBrandPanel } from '@/features/auth/components/AuthBrandPanel';
import { AuthFooter } from '@/features/auth/components/AuthFooter';
import styles from './layout.module.css';

/**
 * The signed-out shell: a form panel on the leading side and the product's own
 * brand panel filling the rest of the screen.
 *
 * No navigation, no session, no skip link — there is nothing to skip past, and a
 * visitor following a password-reset link out of their inbox has no principal to
 * resolve.
 *
 * ## Branded before anyone has signed in (TAR-29 / TAR-35)
 *
 * This is the surface that forced `GET /v1/tenant/public` to be unauthenticated.
 * An agent arriving at their own company's sign-in page must not be shown the
 * platform's name and green first: the tenant is resolved from the *host*, which
 * is known on the very first request, so the logo, the product name and the
 * accent colours are all server-rendered into the first response. The colours
 * arrive through the root layout's token block; the mark and the panel arrive
 * here, from the same request-scoped `readBranding` the rest of the page uses.
 *
 * ## The shape of it (TAR-521)
 *
 * Three landmarks and nothing else: the lockup band, `<main>` with the screen's
 * single `<h1>` in it, and the footer with the support link and the theme
 * control. The form is vertically centred in what is left, with a cap on how far
 * it may drift — see the module file for why a tall screen otherwise leaves it
 * floating in a void.
 *
 * Below 64rem the brand panel is gone and the band above the form takes the rail
 * colour, which is the same brand at a width that has no room for a second panel.
 *
 * `robots` is set here and inherited: a sign-in surface has nothing worth
 * indexing, and a reset URL in a search index would be a link to a dead token.
 */

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const [theme, branding] = await Promise.all([readTheme(), readBranding()]);

  return (
    <div className={styles.layout}>
      <div className={styles.formPanel}>
        {/*
          The one accessible spelling of the product's name on this screen: the
          brand panel beside it is decoration, so this is what a screen reader
          hears and what a logo's `alt` fills in for.
        */}
        <header className={styles.band}>
          <BrandLockup branding={branding} size="lg" isDecorative={false} />
        </header>
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className={styles.content}>
          <div className={styles.column}>{children}</div>
        </main>
        <AuthFooter theme={theme} />
      </div>
      <AuthBrandPanel branding={branding} />
    </div>
  );
}
