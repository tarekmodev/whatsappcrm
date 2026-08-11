import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import type { StackGap } from './Stack';
import styles from './AutoGrid.module.css';

/**
 * Auto-fitting grid. Usage: `<AutoGrid minItemWidth="18rem">…</AutoGrid>`.
 *
 * Column count comes from `auto-fit` + `minmax`, so it reflows continuously from
 * 320px to ultrawide with no breakpoints at all. The minimum item width is passed
 * as a custom property because it is genuinely per-instance content data; the rule
 * that consumes it lives in the module.
 */

export interface AutoGridProps {
  children: ReactNode;
  /** Narrowest an item may get before the grid drops a column. */
  minItemWidth?: string;
  gap?: StackGap;
  className?: string;
}

export function AutoGrid({
  children,
  minItemWidth = '18rem',
  gap = '4',
  className,
}: AutoGridProps) {
  return (
    <div
      className={cx(styles.grid, className)}
      data-gap={gap}
      style={{ '--auto-grid-min-item': minItemWidth } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
