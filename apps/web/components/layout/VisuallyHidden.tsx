import type { ElementType, ReactNode } from 'react';
import styles from './VisuallyHidden.module.css';

/**
 * Content for screen readers only. Usage: `<VisuallyHidden>Loading</VisuallyHidden>`.
 * `display: none` would hide it from assistive technology too, which defeats the
 * point; this clips it instead.
 */
export function VisuallyHidden({
  children,
  as: Element = 'span',
}: {
  children: ReactNode;
  as?: ElementType;
}) {
  return <Element className={styles.visuallyHidden}>{children}</Element>;
}
