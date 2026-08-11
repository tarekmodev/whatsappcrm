import Link from 'next/link';
import styles from './FilterPills.module.css';

/**
 * The one filter-pill strip. Usage:
 * `<FilterPills label="Conversation scope" items={scopes} />`.
 *
 * 0001 puts a row of pills above every list view. They are links, so the filter
 * they apply lives in the URL and survives a refresh, a copied link and the back
 * button — which is also why `isCurrent` is the caller's answer rather than a
 * pathname comparison: a pill usually differs from its neighbours by a query
 * parameter, not by a path.
 *
 * A strip with one pill in it renders nothing. A filter offering no choice is
 * not a filter, and a single dead pill reads as a broken control.
 */

export interface FilterPillItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly isCurrent: boolean;
}

export interface FilterPillsProps {
  /** Names the strip for assistive technology: "Conversation scope", not "Filters". */
  label: string;
  items: readonly FilterPillItem[];
}

export function FilterPills({ label, items }: FilterPillsProps) {
  if (items.length < 2) {
    return null;
  }

  return (
    <nav aria-label={label}>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={item.href}
              className={styles.pill}
              aria-current={item.isCurrent ? 'page' : undefined}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
