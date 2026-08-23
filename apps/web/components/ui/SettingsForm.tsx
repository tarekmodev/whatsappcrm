'use client';

import type { FormEventHandler, ReactNode } from 'react';
import { FieldLayoutProvider } from './Field';
import styles from './SettingsForm.module.css';

/**
 * The settings-form layout (TAR-710). Usage:
 *
 * ```tsx
 * <SettingsForm onSubmit={…}>
 *   <SettingsFormSection>
 *     <Field label="Answer customers automatically" hint="…">{…}</Field>
 *     <Field label="Model" hint="…">{…}</Field>
 *   </SettingsFormSection>
 *   <SettingsFormSection>…</SettingsFormSection>
 *   <SettingsFormActions>
 *     <Button type="submit" variant="primary">Save changes</Button>
 *   </SettingsFormActions>
 * </SettingsForm>
 * ```
 *
 * A settings form is not a dialog form: its fields are long-lived facts about
 * the workspace, each with a sentence of explanation, and stacking them in a
 * 26rem column inside a full-width card leaves the widest unused area in the
 * product. From 64rem this puts the name and the explanation in the leading
 * column and the control in the trailing one; below it, the same fields stack,
 * which is what they already did at every width. The rule and the reasoning are
 * in 0001 under "Settings forms".
 *
 * The layout is published to the fields through context rather than passed to
 * each one, because a `Field` two components deep — `ModelChoiceField`,
 * `ConfidenceBand` — still belongs to this form's layout, and threading a prop
 * through each of them would let one be forgotten.
 *
 * `noValidate` is set here rather than by each caller: the app validates in the
 * component and reports through `Field`, so no settings form wants a native
 * bubble that no theme reaches and no test can read.
 */

export interface SettingsFormProps {
  children: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  /**
   * `div` for a skeleton, which mirrors the layout without being submittable.
   * Rendering the real layout is what stops the skeleton drifting from it.
   */
  as?: 'form' | 'div';
}

export function SettingsForm({ children, onSubmit, as = 'form' }: SettingsFormProps) {
  return (
    <FieldLayoutProvider value="split">
      {as === 'form' ? (
        <form className={styles.form} noValidate onSubmit={onSubmit}>
          {children}
        </form>
      ) : (
        <div className={styles.form}>{children}</div>
      )}
    </FieldLayoutProvider>
  );
}

/**
 * One logical group of fields — `--space-6` between them, and a hairline above
 * the group where another one precedes it. The rule sits on the section rather
 * than being drawn by the caller, so a form cannot end on a stray divider.
 */
export function SettingsFormSection({ children }: { children: ReactNode }) {
  return <div className={styles.section}>{children}</div>;
}

/** The form's actions, on their own row at the trailing edge. */
export function SettingsFormActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}
