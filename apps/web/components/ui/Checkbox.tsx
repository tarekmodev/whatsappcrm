'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import styles from './Checkbox.module.css';

/**
 * A checkbox with this app's face on it. Usage:
 * `<Checkbox checked={isSelected} onChange={…} />`, inside a `<label>` or a
 * `Field`, never on its own.
 *
 * For a **genuine multi-select or a consent tick** — one of several things a
 * user is choosing, committed by a submit. A setting that takes effect the
 * moment it is flipped is a `Switch`, not this.
 *
 * The element is the native input with `appearance: none`, so the box below is
 * drawn from `TextInput`'s border, radius and disabled roles and the two cannot
 * drift apart. The tick is this app's `Icon` rather than the platform glyph or
 * an inlined SVG, for the same reason `Select` draws its own chevron: a data URI
 * would carry a colour no theme could reach.
 */

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'>;

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, ...rest },
  ref,
) {
  return (
    <span className={cx(styles.checkbox, className)}>
      <input {...rest} ref={ref} type="checkbox" className={styles.input} />
      <Icon name="check" size="sm" className={styles.tick} />
    </span>
  );
});
