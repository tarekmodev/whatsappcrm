import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import type { SessionPrincipal, TenantBranding } from '@whatsappcrm/contracts';
import { routes } from '@/lib/routes';
import { BrandLogo } from '@/components/brand/BrandLogo';
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
 * app switcher, a help entry and an assistant. Each of them is a feature this
 * product does not have, and a shell affordance for a feature that does not
 * exist is a promise the app breaks the moment somebody presses it. They arrive
 * with the stories that build what is behind them.
 *
 * The notification bell was on that list until TAR-26 built what sits behind it.
 * `alerts` is that slot: a supervisor's SLA breaches, passed in by the layout
 * and omitted entirely for a principal who can never receive one.
 */
export function AppTopBar({
  items,
  principal,
  branding,
  quickCreateItems,
  alerts,
  utilities,
}: {
  items: readonly NavItem[];
  principal: SessionPrincipal;
  /** The resolved tenant's branding; the small-screen wordmark comes from it. */
  branding: TenantBranding;
  /** Already filtered by permission; an empty list renders no `+`. */
  quickCreateItems: readonly QuickCreateItem[];
  /**
   * The SLA alert bell (TAR-26), or nothing. Passed in rather than rendered
   * here so the shell owns no feature data access — and so a role without
   * `sla:read` gets no bell at all rather than one that is always empty.
   */
  alerts?: ReactNode;
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
        <Link href={routes.inbox()} className={styles.brand} aria-label={branding.productName}>
          {branding.logo === null ? branding.productName : <BrandLogo branding={branding} />}
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
        {alerts}
        <QuickCreateMenu items={quickCreateItems} />
        <div className={styles.account}>
          <PrincipalMenu principal={principal}>{utilities}</PrincipalMenu>
        </div>
      </div>
    </header>
  );
}
