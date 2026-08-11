'use client';

import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import styles from './Control.module.css';

/**
 * Multi-line text control. Usage:
 * `<Textarea rows={3} maxLength={…} … />`, always inside a `Field`.
 *
 * Shares `Control.module.css` with `TextInput` and `Select` so the three cannot
 * drift apart visually, and keeps the native resize handle — taking it away only
 * makes a long note harder to write.
 */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, rows = 3, ...rest }, ref) {
  return (
    <textarea
      {...rest}
      ref={ref}
      rows={rows}
      className={cx(styles.control, styles.textarea, className)}
    />
  );
});
