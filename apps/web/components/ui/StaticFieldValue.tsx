import type { ReactNode } from 'react';
import styles from './StaticFieldValue.module.css';

/**
 * A field's value shown as text instead of as a control. Usage, inside a `Field`:
 *
 * ```tsx
 * <Field label="Role" hint="Only an admin can change someone’s role.">
 *   {({ controlId }) => <StaticFieldValue id={controlId}>Supervisor</StaticFieldValue>}
 * </Field>
 * ```
 *
 * Preferred over a `disabled` input when the caller may not change the value at
 * all: a disabled control implies "not right now", and it is skipped by keyboard
 * navigation, so the value becomes unreadable to a screen-reader user who tabs.
 * Sized like a control so a form's rhythm does not shift between the variant that
 * can edit and the variant that cannot.
 */
export function StaticFieldValue({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} className={styles.value}>
      {children}
    </p>
  );
}
