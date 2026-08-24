import type { ReactNode } from 'react';
import Link from 'next/link';
import type { TenantBranding } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { RAIL_NAV_ID } from '@/lib/shell/rail';
import { BrandLockup } from '@/components/brand/BrandLockup';
import { RailNav } from './RailNav';
import { RailToggle } from './RailToggle';
import type { NavItem } from './navigation';
import styles from './AppSidebar.module.css';

/**
 * The fixed navigation rail. Usage:
 * `<AppSidebar items={visibleItems} footer={<RailCard …/>} />`.
 *
 * A server component: it takes the already-filtered nav items, so the permission
 * decision happens once on the server and no client bundle ships the full nav
 * table. `RailNav` and `RailToggle` are the only client islands inside it, and
 * both exist solely to read the rail's width.
 *
 * Hidden below the layout breakpoint — that width is the mobile drawer's
 * (`MobileMenu`), which renders from the same `NavItem[]`.
 */
export function AppSidebar({
  items,
  branding,
  footer,
  homeHref = routes.inbox(),
  navLabel = content.nav.primaryLabel,
}: {
  items: readonly NavItem[];
  /**
   * The resolved tenant's branding. Passed in rather than read here, so the
   * shell owns no data access and the value cannot outlive the request it was
   * resolved for (`lib/branding/read-branding.ts`).
   *
   * The platform-operator console passes `withBrandingDefaults(null)` — the
   * platform's own name and mark. That console is *ours*, not a tenant's, and
   * dressing it in a customer's logo would be the one place white-labelling
   * would actively mislead (TAR-804).
   */
  branding: TenantBranding;
  /**
   * Pinned to the foot of the rail, below the navigation. `RailCard` is the
   * shape it expects; see that component for what belongs there and why nothing
   * passes one today.
   */
  footer?: ReactNode;
  /**
   * Where the lockup links. The tenant console's home is the inbox; the operator
   * console's is its tenant lookup, and a rail that always went to `/inbox`
   * would take an operator out of the surface their credential authenticates.
   */
  homeHref?: string;
  /**
   * The `<nav>` landmark's accessible name. Two navigation landmarks in one
   * document would be indistinguishable without it — and while no page renders
   * both today, "Primary" is the tenant console's word for its own nav rather
   * than a name every rail can wear.
   */
  navLabel?: string;
}) {
  return (
    // A plain wrapper, not `<aside>`: this holds the *primary* navigation, and
    // the complementary landmark `<aside>` implies would misfile it. The `<nav>`
    // inside is the landmark.
    <div className={styles.rail}>
      <div className={styles.brandRow}>
        <Link href={homeHref} className={styles.brand} aria-label={branding.productName}>
          {/* The same lockup the top bar and the sign-in screen render, including
              what it does with the tenant's logo and what it drops when the rail
              collapses. */}
          <BrandLockup branding={branding} />
        </Link>
        <RailToggle />
      </div>

      <nav id={RAIL_NAV_ID} aria-label={navLabel} className={styles.nav}>
        <RailNav items={items} />
      </nav>

      {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
    </div>
  );
}
