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

/**
 * How tall an item is. `stretch` gives a row equal heights, which is right when
 * every item is a filled card. `start` lets each item be exactly as tall as its
 * contents, which is right when they are not — a short tile stretched to match a
 * tall neighbour is a tile with dead space in it (TAR-519).
 */
export const AUTO_GRID_ALIGNMENTS = ['stretch', 'start'] as const;
export type AutoGridAlignment = (typeof AUTO_GRID_ALIGNMENTS)[number];

export interface AutoGridProps {
  children: ReactNode;
  /** Narrowest an item may get before the grid drops a column. */
  minItemWidth?: string;
  gap?: StackGap;
  align?: AutoGridAlignment;
  className?: string;
}

export function AutoGrid({
  children,
  minItemWidth = '18rem',
  gap = '4',
  align = 'stretch',
  className,
}: AutoGridProps) {
  return (
    <div
      className={cx(styles.grid, className)}
      data-gap={gap}
      data-align={align}
      style={{ '--auto-grid-min-item': minItemWidth } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
