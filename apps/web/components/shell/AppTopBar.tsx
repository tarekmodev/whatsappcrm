import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import type { SessionPrincipal } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { MobileMenu } from './MobileMenu';
import { PrincipalIdentity } from './PrincipalIdentity';
import { PrincipalMenu } from './PrincipalMenu';
import { QuickCreateMenu } from './QuickCreateMenu';
import { TopBarSearch, TopBarSearchSkeleton } from './TopBarSearch';
import type { QuickCreateItem } from './quick-create';
import type { NavItem } from './navigation';
import styles from './AppTopBar.module.css';

/**
 * The console's top bar. Usage:
 * `<AppTopBar items={…} principal={…} quickCreateItems={…} utilities={<ThemeToggle …/>} />`.
 *
 * A server component. `MobileMenu`, `TopBarSearch`, `QuickCreateMenu` and
 * `PrincipalMenu` are the client islands inside it; the drawer renders from the
 * same `NavItem[]` the rail does — the drawer is the rail at small widths, not a
 * second copy of the navigation.
 *
 * The wordmark here is the small-screen one: above the layout breakpoint the
 * rail carries it, and repeating it in the bar would say the same thing twice.
 *
 * ## What is not in this bar
 *
 * The reference layout this was rebuilt against also carries a call button, an
 * app switcher, a help entry, a notification bell and an assistant. Each of them
 * is a feature this product does not have, and a shell affordance for a feature
 * that does not exist is a promise the app breaks the moment somebody presses
 * it. They arrive with the stories that build what is behind them.
 */
export function AppTopBar({
  items,
  principal,
  quickCreateItems,
  utilities,
}: {
  items: readonly NavItem[];
  principal: SessionPrincipal;
  /** Already filtered by permission; an empty list renders no `+`. */
  quickCreateItems: readonly QuickCreateItem[];
  /** Theme toggle and, while TAR-35 is pending, the role stub switcher. */
  utilities?: ReactNode;
}) {
  return (
    <header className={styles.bar}>
      <div className={styles.start}>
        <MobileMenu items={items}>
          {/* The drawer shows the identity flat above the same controls: it has
              the room the bar does not, and a menu inside a drawer is a second
              layer for nothing. */}
          <PrincipalIdentity principal={principal} />
          {utilities}
        </MobileMenu>
        <Link href={routes.inbox()} className={styles.brand}>
          {content.app.name}
        </Link>
      </div>

      {/*
        A sibling of the two groups rather than a child of either, so it can drop
        to its own line below the layout breakpoint — where the drawer trigger,
        the wordmark and the quick-create leave it about 30px of a 320px screen —
        and sit between them above it. `order` in the module file does both.

        `useSearchParams` reads a value only the request knows, so the field is a
        suspense boundary of its own: without one it would opt every route below
        this layout out of static rendering. The fallback is the same pill at the
        same size, so the bar does not shift.
      */}
      <div className={styles.search}>
        <Suspense fallback={<TopBarSearchSkeleton />}>
          <TopBarSearch />
        </Suspense>
      </div>

      <div className={styles.end}>
        <QuickCreateMenu items={quickCreateItems} />
        <div className={styles.account}>
          <PrincipalMenu principal={principal}>{utilities}</PrincipalMenu>
        </div>
      </div>
    </header>
  );
}
