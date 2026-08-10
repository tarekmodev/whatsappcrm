import type { ReactNode } from 'react';
import Link from 'next/link';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { Container } from '@/components/layout/Container';
import { MobileMenu } from './MobileMenu';
import { NavLinkList } from './NavLinkList';
import type { NavItem } from './navigation';
import styles from './AppHeader.module.css';

/**
 * The app shell's header. Usage:
 * `<AppHeader items={visibleItems} utilities={<ThemeToggle …/>} />`.
 *
 * A server component: it takes the already-filtered nav items, so the permission
 * decision happens once on the server and no client bundle ships the full nav
 * table. `MobileMenu` is the only client island inside it.
 */
export function AppHeader({
  items,
  utilities,
}: {
  items: readonly NavItem[];
  /** Theme toggle and, while TAR-35 is pending, the role stub switcher. */
  utilities?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <Container size="xl" className={styles.inner}>
        <div className={styles.brandGroup}>
          <MobileMenu items={items}>{utilities}</MobileMenu>
          <Link href={routes.inbox()} className={styles.brand}>
            {content.app.name}
          </Link>
        </div>

        <nav aria-label={content.nav.primaryLabel} className={styles.desktopNav}>
          <NavLinkList items={items} orientation="horizontal" />
        </nav>

        {utilities === undefined ? null : <div className={styles.utilities}>{utilities}</div>}
      </Container>
    </header>
  );
}
