import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { content } from '@/content/en';
import { readTheme } from '@/lib/theme/read-theme';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';
import styles from './layout.module.css';

/**
 * The signed-out shell: a centred column with the workspace wordmark above it.
 *
 * No navigation, no session, no skip link — there is nothing to skip past, and a
 * visitor following a password-reset link out of their inbox has no principal to
 * resolve. TAR-60's login and invite-accept screens drop in beside TAR-61's
 * password screens and inherit this frame unchanged.
 *
 * The wordmark is text from the content layer rather than an image, so TAR-29's
 * white-label branding replaces it by swapping that layer and the token file.
 *
 * `robots` is set here and inherited: a sign-in surface has nothing worth
 * indexing, and a reset URL in a search index would be a link to a dead token.
 */

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const theme = await readTheme();

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className={styles.main}>
      <div className={styles.utilities}>
        <ThemeToggle initialTheme={theme} />
      </div>
      <div className={styles.column}>
        <p className={styles.wordmark}>{content.app.name}</p>
        {children}
      </div>
    </main>
  );
}
