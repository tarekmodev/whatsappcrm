import type { ElementType, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { STACK_GAPS, type StackGap } from './Stack';
import styles from './Cluster.module.css';

/**
 * Horizontal group that wraps instead of overflowing. Usage:
 * `<Cluster gap="2" justify="between">…</Cluster>`.
 *
 * Wrapping is the default because a toolbar that cannot wrap is the most common
 * source of horizontal scroll at 320px.
 */

export const CLUSTER_JUSTIFY = ['start', 'between', 'end'] as const;
export const CLUSTER_ALIGN = ['start', 'center', 'end', 'baseline'] as const;

export type ClusterJustify = (typeof CLUSTER_JUSTIFY)[number];
export type ClusterAlign = (typeof CLUSTER_ALIGN)[number];

export interface ClusterProps {
  children: ReactNode;
  gap?: StackGap;
  justify?: ClusterJustify;
  align?: ClusterAlign;
  as?: ElementType;
  className?: string;
}

export function Cluster({
  children,
  gap = '3',
  justify = 'start',
  align = 'center',
  as: Element = 'div',
  className,
}: ClusterProps) {
  return (
    <Element
      className={cx(styles.cluster, className)}
      data-gap={gap}
      data-justify={justify}
      data-align={align}
    >
      {children}
    </Element>
  );
}

export { STACK_GAPS as CLUSTER_GAPS };
