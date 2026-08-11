import Link from 'next/link';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { RAIL_NAV_ID } from '@/lib/shell/rail';
import { RailNav } from './RailNav';
import { RailToggle } from './RailToggle';
import type { NavItem } from './navigation';
import styles from './AppSidebar.module.css';

/**
 * The fixed navigation rail. Usage: `<AppSidebar items={visibleItems} />`.
 *
 * A server component: it takes the already-filtered nav items, so the permission
 * decision happens once on the server and no client bundle ships the full nav
 * table. `RailNav` and `RailToggle` are the only client islands inside it, and
 * both exist solely to read the rail's width.
 *
 * Hidden below the layout breakpoint — that width is the mobile drawer's
 * (`MobileMenu`), which renders from the same `NavItem[]`.
 */
export function AppSidebar({ items }: { items: readonly NavItem[] }) {
  return (
    // A plain wrapper, not `<aside>`: this holds the *primary* navigation, and
    // the complementary landmark `<aside>` implies would misfile it. The `<nav>`
    // inside is the landmark.
    <div className={styles.rail}>
      <div className={styles.brandRow}>
        <Link href={routes.inbox()} className={styles.brand}>
          {/*
            Two spellings of the same wordmark: the full name, and the initial
            that survives the collapsed width. Both are content, so TAR-29's
            white-label branding replaces them in one place.
          */}
          <span className={styles.brandMark} aria-hidden="true">
            {content.app.name.charAt(0)}
          </span>
          <span className={styles.brandName}>{content.app.name}</span>
        </Link>
        <RailToggle />
      </div>

      <nav id={RAIL_NAV_ID} aria-label={content.nav.primaryLabel} className={styles.nav}>
        <RailNav items={items} />
      </nav>
    </div>
  );
}
