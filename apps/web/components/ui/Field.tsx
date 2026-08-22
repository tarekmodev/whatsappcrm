'use client';

import { createContext, useContext, useId, type ReactNode } from 'react';
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

/**
 * How a field arranges its two halves.
 *
 * `stacked` is the default and what a dialog, a filter bar and a signed-out form
 * all want. `split` is the settings-form pattern — label and hint in the leading
 * column, control in the trailing one, from 64rem up — and it is set by
 * `SettingsForm` for everything inside it rather than passed to each field,
 * because a field two components deep inside a form still belongs to that form's
 * layout (see 0001's "Settings forms").
 */
export const FIELD_LAYOUTS = ['stacked', 'split'] as const;
export type FieldLayout = (typeof FIELD_LAYOUTS)[number];

const FieldLayoutContext = createContext<FieldLayout>('stacked');

export const FieldLayoutProvider = FieldLayoutContext.Provider;

export function useFieldLayout(): FieldLayout {
  return useContext(FieldLayoutContext);
}

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
  const layout = useFieldLayout();
  const baseId = useId();
  const controlId = `${baseId}-control`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;

  const describedBy =
    [hint === undefined ? null : hintId, error === undefined ? null : errorId]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;

  return (
    <div className={styles.field} data-layout={layout}>
      {/*
       * The two halves are wrapped rather than left as four siblings so the
       * split layout has two boxes to place in two columns. Stacked, the
       * wrappers carry the same gap the field used to, so nothing moves.
       */}
      <div
        className={styles.labelGroup}
        // A hidden label with nothing else in it is not a row of the layout: the
        // wrapper drops out entirely rather than contributing an empty box and
        // the gap that goes with it.
        data-empty={isLabelHidden && hint === undefined ? 'true' : undefined}
      >
        <label className={styles.label} htmlFor={controlId} data-hidden={isLabelHidden}>
          {label}
          {isRequired ? <span aria-hidden="true"> *</span> : null}
        </label>
        {hint === undefined ? null : (
          <p id={hintId} className={styles.hint}>
            {hint}
          </p>
        )}
      </div>
      <div className={styles.controlGroup}>
        {children({ controlId, describedBy, isInvalid: error !== undefined })}
        {error === undefined ? null : (
          <p id={errorId} className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
