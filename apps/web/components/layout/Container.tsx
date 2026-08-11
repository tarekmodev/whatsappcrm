import type { ElementType, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Container.module.css';

/**
 * Centres content and owns the gutter. Usage: `<Container size="lg">…</Container>`.
 * The gutter is fluid, so nothing needs a breakpoint to stay off the edge at 320px.
 */

export const CONTAINER_SIZES = ['sm', 'md', 'lg', 'xl'] as const;
export type ContainerSize = (typeof CONTAINER_SIZES)[number];

export interface ContainerProps {
  children: ReactNode;
  size?: ContainerSize;
  as?: ElementType;
  className?: string;
  id?: string;
}

export function Container({
  children,
  size = 'lg',
  as: Element = 'div',
  className,
  id,
}: ContainerProps) {
  return (
    <Element id={id} className={cx(styles.container, className)} data-size={size}>
      {children}
    </Element>
  );
}
