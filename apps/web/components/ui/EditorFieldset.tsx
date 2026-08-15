'use client';

import type { ReactNode } from 'react';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { Button } from './Button';
import styles from './EditorFieldset.module.css';

/**
 * The frame around a list a form grows and shrinks — conditions, actions, any
 * repeatable group. Usage:
 *
 * ```tsx
 * <EditorFieldset legend="Actions" hint="…" addLabel="Add action" onAdd={…}>
 *   {actions.map((action, index) => (
 *     <EditorRow key={index} heading="Action 1" removeLabel="Remove" …>…</EditorRow>
 *   ))}
 * </EditorFieldset>
 * ```
 *
 * A real `fieldset`/`legend`, because the rows are one question asked as several
 * controls, and the legend is where the group's own rule is stated — "every one
 * of these has to hold", "these run in order".
 *
 * Owning the frame here is what keeps the routing-rule condition editor and the
 * workflow builder's two editors identical without any of them restating it.
 */
export function EditorFieldset({
  legend,
  hint,
  error,
  children,
  addLabel,
  onAdd,
  isFull = false,
  fullHint,
}: {
  legend: string;
  children: ReactNode;
  addLabel: string;
  onAdd: () => void;
  /** The group's own rule, above the rows. */
  hint?: string;
  /** A failure about the list itself — that it is empty. */
  error?: string;
  /** True at the contract's cap; the add control stands down and says why. */
  isFull?: boolean;
  fullHint?: string;
}) {
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{legend}</legend>
      {hint === undefined ? null : <p className={styles.hint}>{hint}</p>}
      {error === undefined ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <Stack gap="3" as="ul" className={styles.list}>
        {children}
      </Stack>

      <Button variant="secondary" size="sm" disabled={isFull} onClick={onAdd}>
        {addLabel}
      </Button>
      {isFull && fullHint !== undefined ? <p className={styles.hint}>{fullHint}</p> : null}
    </fieldset>
  );
}

/** One row inside an `EditorFieldset`: its heading, its controls, and Remove. */
export function EditorRow({
  heading,
  removeLabel,
  removeAriaLabel,
  isRemovable,
  onRemove,
  children,
}: {
  heading: string;
  removeLabel: string;
  removeAriaLabel: string;
  isRemovable: boolean;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <li className={styles.row}>
      <Cluster justify="between" align="center" gap="2">
        <h4 className={styles.rowHeading}>{heading}</h4>
        {isRemovable ? (
          <Button variant="ghost" size="sm" aria-label={removeAriaLabel} onClick={onRemove}>
            {removeLabel}
          </Button>
        ) : null}
      </Cluster>

      <Stack gap="3">{children}</Stack>
    </li>
  );
}
