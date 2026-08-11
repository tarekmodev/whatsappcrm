import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

/**
 * The shared empty state. Usage:
 * `<EmptyState heading={…} body={…} action={<Button …/>} />`.
 *
 * An empty region explains why it is empty and offers the primary action; a blank
 * panel reads as a bug. Sized like the content it replaces so the transition from
 * skeleton to empty does not shift the page.
 */
export function EmptyState({
  heading,
  body,
  action,
}: {
  heading: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <p className={styles.heading}>{heading}</p>
      <p className={styles.body}>{body}</p>
      {action === undefined ? null : <div>{action}</div>}
    </div>
  );
}
