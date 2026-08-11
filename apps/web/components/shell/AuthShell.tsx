import type { ReactNode } from 'react';
import { content } from '@/content/en';
import { Container } from '@/components/layout/Container';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import type { Theme } from '@/lib/theme/theme';
import { MAIN_CONTENT_ID } from './main-content';
import styles from './AuthShell.module.css';

/**
 * The frame every signed-out screen sits in. Usage:
 * `<AuthShell theme={theme}>{card}</AuthShell>`.
 *
 * Deliberately thin: a wordmark, the theme toggle and a centred single-column
 * measure. There is no navigation to skip past, so there is no skip link and no
 * mobile menu — the whole surface is one column at every width, which is what an
 * unauthenticated screen should be.
 *
 * Shared by sign-in and invite acceptance today, and by TAR-61's reset screens,
 * so none of them re-invents the frame.
 */
export function AuthShell({ children, theme }: { children: ReactNode; theme: Theme }) {
  return (
    <div className={styles.shell}>
      <Container size="xl" as="header" className={styles.bar}>
        <span className={styles.brand}>{content.app.name}</span>
        <ThemeToggle initialTheme={theme} />
      </Container>

      {/* `tabIndex={-1}` so focus can be moved here programmatically without the
          landmark joining the tab order. */}
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className={styles.main}>
        <Container size="sm" className={styles.column}>
          {children}
        </Container>
      </main>
    </div>
  );
}
