'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isCurrentPath } from '@/lib/current-path';
import styles from './Tabs.module.css';

/**
 * The one tab strip. Usage:
 * `<Tabs label="Settings sections" items={[{ id: 'people', label: 'People', href: '/settings/people' }]} />`.
 *
 * Real links inside a `<nav>`, not buttons: a tab that changes what the page
 * shows is a destination, so it must be shareable, middle-clickable and
 * restored by the back button. The current one carries `aria-current="page"`,
 * which is also what the underline is drawn from.
 *
 * This is the strip 0001 rules for a detail view's activity tabs and for a list
 * view's sections. A tab strip whose state is not in the URL does not belong
 * here — it belongs in the URL first.
 */

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
}

export interface TabsProps {
  /** Names the strip for assistive technology: "Settings sections", not "Tabs". */
  label: string;
  items: readonly TabItem[];
}

export function Tabs({ label, items }: TabsProps) {
  const pathname = usePathname();

  return (
    <nav aria-label={label} className={styles.tabs}>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={item.href}
              className={styles.tab}
              aria-current={isCurrentPath(pathname, item.href) ? 'page' : undefined}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
