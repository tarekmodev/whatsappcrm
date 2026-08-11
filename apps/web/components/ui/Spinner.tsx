import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import styles from './Spinner.module.css';

/**
 * A short, in-place pending indicator. Usage: `<Spinner label="Saving…" />`.
 *
 * Allowed only for local waits such as a button's pending state. Page and section
 * content uses a structure-matching skeleton instead — see `Skeleton`.
 */
export function Spinner({ label }: { label: string }) {
  return (
    <span className={styles.spinner} role="status">
      <span aria-hidden="true" className={styles.arc} />
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
}
