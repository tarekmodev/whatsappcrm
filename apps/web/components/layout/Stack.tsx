import type { ElementType, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Stack.module.css';

/**
 * Vertical rhythm primitive. Usage: `<Stack gap="4">…</Stack>`.
 *
 * Exists so no feature component ever writes `margin-top` — spacing between
 * siblings is the parent's job, which is what keeps a component reusable in a
 * layout its author never saw.
 */

export const STACK_GAPS = ['1', '2', '3', '4', '5', '6', '7'] as const;
export type StackGap = (typeof STACK_GAPS)[number];

export interface StackProps {
  children: ReactNode;
  gap?: StackGap;
  as?: ElementType;
  className?: string;
}

export function Stack({ children, gap = '4', as: Element = 'div', className }: StackProps) {
  return (
    <Element className={cx(styles.stack, className)} data-gap={gap}>
      {children}
    </Element>
  );
}
