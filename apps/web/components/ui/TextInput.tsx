'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import styles from './Control.module.css';

/**
 * Text-like input. Usage: `<TextInput type="email" autoComplete="email" … />`.
 * Native `type`, `inputMode` and `autoComplete` are pass-through so a form can
 * get the right mobile keyboard without a wrapper prop for each one.
 */
export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, type = 'text', ...rest }, ref) {
    return <input {...rest} ref={ref} type={type} className={cx(styles.control, className)} />;
  },
);
