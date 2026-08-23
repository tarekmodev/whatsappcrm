import type { ReactNode } from 'react';
import Link from 'next/link';
import type { TenantBranding } from '@whatsappcrm/contracts';
import { routes } from '@/lib/routes';
import { BrandLockup } from '@/components/brand/BrandLockup';
import { MobileMenu } from './MobileMenu';
import type { NavItem } from './navigation';
import styles from './AdminTopBar.module.css';

/**
 * The platform-operator console's top bar. Usage:
 * `<AdminTopBar items={ADMIN_NAV_ITEMS} branding={platformBranding} utilities={…} />`.
 *
 * A server component, like `AppTopBar`, with `MobileMenu` as its one client
 * island — and the drawer renders from the same `NavItem[]` the rail does, so
 * this surface has one copy of its navigation at every width.
 *
 * ## Why it is not `AppTopBar` with optional props
 *
 * `AppTopBar` carries a principal, a workspace search, a quick-create menu and an
 * alert bell. Every one of those is a *tenant* concept: there is no principal on
 * this surface, nothing cross-tenant to search, nothing an operator creates from
 * a menu, and no SLA to breach. Making four of its six props optional would leave
 * one component with two reasons to change and a shape that says nothing about
 * either console.
 *
 * What the two genuinely share is the bar itself — its height, its stickiness,
 * its safe-area inset, the width at which the wordmark stands down — and that is
 * shared as CSS through `composes`, in one file, rather than as a prop matrix.
 */
export function AdminTopBar({
  items,
  branding,
  utilities,
}: {
  items: readonly NavItem[];
  /**
   * The platform's own identity, not a tenant's. See `AppSidebar`'s note: this
   * console is operated by us, and a customer's logo on it would misrepresent
   * whose surface it is.
   */
  branding: TenantBranding;
  /** The theme toggle and the sign-out control, rendered by the layout. */
  utilities?: ReactNode;
}) {
  return (
    <header className={styles.bar}>
      <div className={styles.start}>
        <MobileMenu
          items={items}
          brand={
            <Link
              href={routes.adminTenants()}
              className={styles.drawerBrand}
              aria-label={branding.productName}
            >
              <BrandLockup branding={branding} />
            </Link>
          }
        />
        <Link
          href={routes.adminTenants()}
          className={styles.brand}
          aria-label={branding.productName}
        >
          <BrandLockup branding={branding} />
        </Link>
      </div>

      <div className={styles.spacer} />

      {/*
        In the bar at every width, and deliberately **not** also inside the
        drawer. `AppTopBar` puts its utilities in the account menu and repeats
        them in the drawer, which is safe there because both are collapsed
        surfaces — only one is ever exposed. These two are always-visible icon
        controls, so a second copy in an open drawer would be two "Sign out"
        buttons on screen at once. Two controls plus the trigger and the wordmark
        fit a 320px row with room to spare.
      */}
      <div className={styles.end}>{utilities}</div>
    </header>
  );
}
