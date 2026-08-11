'use client';

import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import styles from './Control.module.css';

/**
 * Native select over a custom listbox: it is keyboard- and screen-reader-correct
 * by construction, and on mobile it opens the platform picker. Usage:
 * `<Select options={ROLE_OPTIONS} … />`.
 */

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: readonly SelectOption[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, className, ...rest },
  ref,
) {
  return (
    <select {...rest} ref={ref} className={cx(styles.control, styles.select, className)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
});
