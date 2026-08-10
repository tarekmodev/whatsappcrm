'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/lib/cx';
import type { NavItem } from './navigation';
import styles from './NavLinkList.module.css';

/**
 * Renders a list of nav links with the current one marked. Usage:
 * `<NavLinkList items={items} orientation="horizontal" />`.
 *
 * Shared by the desktop header, the mobile drawer and the settings sub-nav, so
 * the three cannot disagree about which entry is current.
 */

export const NAV_ORIENTATIONS = ['horizontal', 'vertical'] as const;
export type NavOrientation = (typeof NAV_ORIENTATIONS)[number];

export interface NavLinkListProps {
  items: readonly NavItem[];
  orientation?: NavOrientation;
  onNavigate?: () => void;
}

export function NavLinkList({ items, orientation = 'horizontal', onNavigate }: NavLinkListProps) {
  const pathname = usePathname();

  return (
    <ul className={styles.list} data-orientation={orientation}>
      {items.map((item) => {
        const isCurrent = isCurrentPath(pathname, item.href);

        return (
          <li key={item.id}>
            <Link
              href={item.href}
              className={cx(styles.link)}
              // `aria-current` rather than a class alone, so the state is exposed
              // to assistive technology and not only to the eye.
              aria-current={isCurrent ? 'page' : undefined}
              onClick={onNavigate}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Compares path segments only. A nav href may carry default query parameters
 * (`/inbox?scope=assigned`), and those must not decide whether the entry is
 * current.
 */
function isCurrentPath(pathname: string, href: string): boolean {
  const [target = ''] = href.split('?');

  return pathname === target || pathname.startsWith(`${target}/`);
}
