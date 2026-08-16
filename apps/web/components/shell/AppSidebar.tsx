import type { ReactNode } from 'react';
import Link from 'next/link';
import type { TenantBranding } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { RAIL_NAV_ID } from '@/lib/shell/rail';
import { BrandLogo } from '@/components/brand/BrandLogo';
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
}: {
  items: readonly NavItem[];
  /**
   * The resolved tenant's branding. Passed in rather than read here, so the
   * shell owns no data access and the value cannot outlive the request it was
   * resolved for (`lib/branding/read-branding.ts`).
   */
  branding: TenantBranding;
  /**
   * Pinned to the foot of the rail, below the navigation. `RailCard` is the
   * shape it expects; see that component for what belongs there and why nothing
   * passes one today.
   */
  footer?: ReactNode;
}) {
  return (
    // A plain wrapper, not `<aside>`: this holds the *primary* navigation, and
    // the complementary landmark `<aside>` implies would misfile it. The `<nav>`
    // inside is the landmark.
    <div className={styles.rail}>
      <div className={styles.brandRow}>
        <Link href={routes.inbox()} className={styles.brand} aria-label={branding.productName}>
          {branding.logo === null ? (
            <>
              {/*
                Two spellings of the same wordmark: the full name, and the
                initial that survives the collapsed width. Both come from the
                tenant's branding, so white-labelling replaces them here.
              */}
              <span className={styles.brandMark} aria-hidden="true">
                {branding.productName.charAt(0)}
              </span>
              <span className={styles.brandName}>{branding.productName}</span>
            </>
          ) : (
            <BrandLogo branding={branding} />
          )}
        </Link>
        <RailToggle />
      </div>

      <nav id={RAIL_NAV_ID} aria-label={content.nav.primaryLabel} className={styles.nav}>
        <RailNav items={items} />
      </nav>

      {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
    </div>
  );
}
