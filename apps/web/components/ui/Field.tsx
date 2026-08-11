'use client';

import { useId, type ReactNode } from 'react';
import styles from './Field.module.css';

/**
 * Wires a label, hint and error message to a control exactly once, so no form in
 * the app hand-assembles them. Usage:
 *
 * ```tsx
 * <Field label="Email address" error={errors.email}>
 *   {({ controlId, describedBy, isInvalid }) => (
 *     <TextInput id={controlId} aria-describedby={describedBy} aria-invalid={isInvalid} … />
 *   )}
 * </Field>
 * ```
 *
 * The render-prop shape is what guarantees `aria-describedby` and `aria-invalid`
 * are present: a consumer cannot forget them without leaving the control unwired
 * and visibly unlabelled.
 */

export interface FieldControlProps {
  controlId: string;
  /** Pass straight to the control; already omits absent hint/error ids. */
  describedBy: string | undefined;
  isInvalid: boolean;
}

export interface FieldProps {
  label: string;
  children: (control: FieldControlProps) => ReactNode;
  hint?: string;
  error?: string;
  /** Marks the control required to assistive technology and shows the hint text. */
  isRequired?: boolean;
  /** Renders the label for screen readers only, for a filter whose intent is visual. */
  isLabelHidden?: boolean;
}

export function Field({
  label,
  children,
  hint,
  error,
  isRequired = false,
  isLabelHidden = false,
}: FieldProps) {
  const baseId = useId();
  const controlId = `${baseId}-control`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;

  const describedBy =
    [hint === undefined ? null : hintId, error === undefined ? null : errorId]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={controlId} data-hidden={isLabelHidden}>
        {label}
        {isRequired ? <span aria-hidden="true"> *</span> : null}
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {children({ controlId, describedBy, isInvalid: error !== undefined })}
      {error === undefined ? null : (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
