'use client';

import Link from 'next/link';
import { Icon } from './Icon';
import { useContent } from '@/lib/content';
import styles from './ActiveFilterChips.module.css';

/**
 * What is currently narrowing a list, and how to switch each one off. Usage:
 * `<ActiveFilterChips label="Active filters" items={chips} clearAllHref={…} />`.
 *
 * 0001's filter-row rule (TAR-516): once a screen's secondary filters have
 * collapsed behind a "Filters" menu, the only thing saying the list is narrowed
 * is the count on that trigger — which says how many, never which. This strip
 * says which, and each chip is individually clearable.
 *
 * Chips are **links**, like the pills above them, so a filter stays in the URL
 * and clearing one is a navigation the back button can undo. Nothing renders
 * when nothing is active: an empty strip is a band of vertical space that moves
 * the table every time a filter is applied.
 */

export interface ActiveFilterChip {
  readonly id: string;
  /** The filter group, as its control names it: "Priority". */
  readonly group: string;
  /** What it is narrowed to: "Urgent". */
  readonly value: string;
  /** The current view with this one filter removed. */
  readonly clearHref: string;
}

export interface ActiveFilterChipsProps {
  /** Names the strip for assistive technology. */
  label: string;
  items: readonly ActiveFilterChip[];
  /** Offered once there is more than one chip to clear. */
  clearAllHref?: string;
}

export function ActiveFilterChips({ label, items, clearAllHref }: ActiveFilterChipsProps) {
  const content = useContent();

  if (items.length === 0) {
    return null;
  }

  return (
    <nav aria-label={label}>
      <ul className={styles.list}>
        {items.map((item) => {
          const chip = content.common.filterChip(item.group, item.value);

          return (
            <li key={item.id}>
              <Link
                href={item.clearHref}
                className={styles.chip}
                // Without this the link announces as "Priority: Urgent, link",
                // which reads as "go to the urgent tickets" rather than as
                // "stop filtering by priority".
                aria-label={content.common.clearFilter(chip)}
                scroll={false}
              >
                <span aria-hidden="true">{chip}</span>
                <Icon name="close" size="sm" />
              </Link>
            </li>
          );
        })}
        {items.length > 1 && clearAllHref !== undefined ? (
          <li>
            <Link href={clearAllHref} className={styles.clearAll} scroll={false}>
              {content.common.clearAllFilters}
            </Link>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
