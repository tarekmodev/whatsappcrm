'use client';

import { useId } from 'react';
import styles from './CheckboxGroup.module.css';

/**
 * Multi-select as a real `fieldset`/`legend` of checkboxes. Usage:
 * `<CheckboxGroup legend="Teams" options={…} selectedValues={…} onChange={…} />`.
 *
 * Chosen over a custom multi-select because team membership is a short, known
 * list: checkboxes are keyboard-operable and announced correctly with no
 * JavaScript, and each row already meets the 44px target.
 *
 * Controlled only — team membership always has an owning form.
 */

export interface CheckboxOption {
  value: string;
  label: string;
  hint?: string;
}

export interface CheckboxGroupProps {
  legend: string;
  options: readonly CheckboxOption[];
  selectedValues: readonly string[];
  onChange: (values: readonly string[]) => void;
  hint?: string;
  /** Rendered in place of the list when there is nothing to choose from. */
  emptyLabel?: string;
  name?: string;
}

export function CheckboxGroup({
  legend,
  options,
  selectedValues,
  onChange,
  hint,
  emptyLabel,
  name,
}: CheckboxGroupProps) {
  const baseId = useId();
  const hintId = `${baseId}-hint`;
  const selected = new Set(selectedValues);

  function toggle(value: string, isChecked: boolean): void {
    onChange(
      isChecked
        ? [...selectedValues, value]
        : selectedValues.filter((current) => current !== value),
    );
  }

  return (
    <fieldset className={styles.group} aria-describedby={hint === undefined ? undefined : hintId}>
      <legend className={styles.legend}>{legend}</legend>
      {hint === undefined ? null : (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {options.length === 0 ? (
        <p className={styles.hint}>{emptyLabel}</p>
      ) : (
        <ul className={styles.list}>
          {options.map((option) => (
            <li key={option.value}>
              <label className={styles.option}>
                <input
                  type="checkbox"
                  name={name}
                  value={option.value}
                  checked={selected.has(option.value)}
                  onChange={(event) => {
                    toggle(option.value, event.target.checked);
                  }}
                  className={styles.checkbox}
                />
                <span className={styles.optionText}>
                  <span className={styles.optionLabel}>{option.label}</span>
                  {option.hint === undefined ? null : (
                    <span className={styles.optionHint}>{option.hint}</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
