import type { ReactNode } from 'react';
import Link from 'next/link';
import type { SessionPrincipal } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { MobileMenu } from './MobileMenu';
import { PrincipalIdentity } from './PrincipalIdentity';
import type { NavItem } from './navigation';
import styles from './AppTopBar.module.css';

/**
 * The console's top bar. Usage:
 * `<AppTopBar items={visibleItems} principal={principal} utilities={<ThemeToggle …/>} />`.
 *
 * A server component. `MobileMenu` is the only client island inside it, and it
 * renders from the same `NavItem[]` the rail does — the drawer is the rail at
 * small widths, not a second copy of the navigation.
 *
 * The wordmark here is the small-screen one: above the layout breakpoint the
 * rail carries it, and repeating it in the bar would say the same thing twice.
 *
 * 0001 rules a workspace-wide search field into this bar. It is not built here:
 * the API contract (0002) exposes no search endpoint, and a box that returns
 * nothing is worse than a gap. It lands with the story that adds the endpoint.
 */
export function AppTopBar({
  items,
  principal,
  utilities,
}: {
  items: readonly NavItem[];
  principal: SessionPrincipal;
  /** Theme toggle and, while TAR-35 is pending, the role stub switcher. */
  utilities?: ReactNode;
}) {
  return (
    <header className={styles.bar}>
      <div className={styles.start}>
        <MobileMenu items={items}>{utilities}</MobileMenu>
        <Link href={routes.inbox()} className={styles.brand}>
          {content.app.name}
        </Link>
      </div>

      <div className={styles.end}>
        <PrincipalIdentity principal={principal} />
        {utilities === undefined ? null : <div className={styles.utilities}>{utilities}</div>}
      </div>
    </header>
  );
}
