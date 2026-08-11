'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import styles from './Control.module.css';

/**
 * Native file control. Usage: `<FileInput accept={…} onChange={…} />`, always
 * inside a `Field`.
 *
 * Native, and single-file, on purpose. A real `<input type="file">` is reachable
 * by keyboard, activated by its own `<label>`, announces the chosen file name on
 * change, and opens the platform picker — camera and all — on a phone. A styled
 * drop zone with a click handler has none of that unless every piece is rebuilt,
 * and rebuilding it is where accessible uploads usually go wrong.
 *
 * Shares `Control.module.css` with `TextInput`, `Textarea` and `Select` so the
 * four cannot drift apart.
 */
export const FileInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function FileInput({ className, ...rest }, ref) {
    return (
      <input
        {...rest}
        ref={ref}
        type="file"
        className={cx(styles.control, styles.file, className)}
      />
    );
  },
);
