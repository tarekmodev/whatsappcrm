'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import { isCurrentPath } from '@/lib/current-path';
import type { NavItem } from './navigation';
import styles from './NavLinkList.module.css';

/**
 * Renders a list of nav links with the current one marked. Usage:
 * `<NavLinkList items={items} appearance="rail" isCollapsed={false} />`.
 *
 * Shared by the rail and the mobile drawer, so the two cannot disagree about
 * which entry is current. `appearance` changes how the entries are painted,
 * never what they are — there is one nav data source and one piece of markup
 * for it.
 *
 * The list is always a column. A row of nav links used to be the desktop
 * header; the rail replaced it, and a horizontal tab strip is `Tabs`.
 */

export const NAV_APPEARANCES = ['bar', 'rail'] as const;
/** `bar` sits on a surface; `rail` sits on the dark navigation rail. */
export type NavAppearance = (typeof NAV_APPEARANCES)[number];

export interface NavLinkListProps {
  items: readonly NavItem[];
  appearance?: NavAppearance;
  /**
   * Rail only: hides the labels and leaves the icons. The text stays in the DOM
   * rather than being dropped, so the links keep their accessible names.
   */
  isCollapsed?: boolean;
  onNavigate?: () => void;
}

export function NavLinkList({
  items,
  appearance = 'bar',
  isCollapsed = false,
  onNavigate,
}: NavLinkListProps) {
  const pathname = usePathname();

  return (
    <ul
      className={styles.list}
      data-appearance={appearance}
      data-collapsed={isCollapsed ? 'true' : undefined}
    >
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
              // Collapsed, the label is the only thing naming the icon, and it is
              // off-screen — so the pointer gets it back as a native tooltip.
              title={isCollapsed ? item.label : undefined}
              onClick={onNavigate}
            >
              {item.icon === undefined ? null : <Icon name={item.icon} />}
              <span className={styles.label}>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
