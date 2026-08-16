import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { readTheme } from '@/lib/theme/read-theme';
import { readBranding } from '@/lib/branding/read-branding';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';
import styles from './layout.module.css';

/**
 * The signed-out shell: a centred column with the tenant's mark above it.
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
 * arrive through the root layout's token block; the mark arrives here.
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
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className={styles.main}>
      <div className={styles.utilities}>
        <ThemeToggle initialTheme={theme} />
      </div>
      <div className={styles.column}>
        {branding.logo === null ? (
          <p className={styles.wordmark}>{branding.productName}</p>
        ) : (
          // Not decorative here: there is no link or heading beside it naming
          // the workspace, so this image is the only thing that does.
          <div className={styles.mark}>
            <BrandLogo branding={branding} size="lg" isDecorative={false} />
          </div>
        )}
        {children}
      </div>
    </main>
  );
}
