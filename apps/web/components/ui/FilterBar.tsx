import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './FilterBar.module.css';

/**
 * The filter row every list view sits under. Usage:
 * `<FilterBar label="Ticket filters"><FilterPills … /><Select variant="filter" … /></FilterBar>`.
 *
 * 0001's list-view pattern (TAR-516): filters sit **in one row on one baseline**,
 * in a `--color-surface` bar with a hairline, rather than floating on the canvas
 * as separate groups with a label over each. Three screens had independently
 * invented their own version of this row; this is the one they share.
 *
 * `chips` renders under the row and is where an "active filters" strip goes when
 * the secondary groups have collapsed into a menu — see `ActiveFilterChips`.
 * It is a separate slot rather than another child so the row cannot accidentally
 * put a chip on the controls' baseline.
 */

export interface FilterBarProps {
  /** Names the region for assistive technology: "Ticket filters". */
  label: string;
  children: ReactNode;
  /** Controls pinned to the far edge of the row — apply, reset, an export. */
  trailing?: ReactNode;
  /** The active-filter strip, beneath the controls. */
  chips?: ReactNode;
  className?: string;
}

export function FilterBar({ label, children, trailing, chips, className }: FilterBarProps) {
  return (
    <section aria-label={label} className={cx(styles.bar, className)}>
      <div className={styles.row}>
        {children}
        {trailing === undefined ? null : <div className={styles.trailing}>{trailing}</div>}
      </div>
      {chips}
    </section>
  );
}
