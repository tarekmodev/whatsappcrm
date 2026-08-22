'use client';

import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import { SkeletonBlock } from './Skeleton';
import controlStyles from './Control.module.css';
import styles from './Select.module.css';

/**
 * Single choice from a short list. Usage:
 * `<Select options={ROLE_OPTIONS} … />`, or `<Select variant="filter" … />`
 * above a list view.
 *
 * **A native `<select>` under a designed face** (TAR-516). The element keeps the
 * keyboard model, the type-ahead, the screen-reader announcement and the platform
 * picker on mobile — everything a custom listbox has to re-earn and usually gets
 * wrong. What was replaced is only the browser's own painting of it: the box now
 * shares `Control.module.css` with `TextInput` down to the last token, and the
 * disclosure chevron is this app's `Icon` rather than the OS glyph, so a filter
 * sitting beside a search box no longer reads as a control from a different app.
 *
 * The options list itself is still the platform's. That is deliberate: a popover
 * of options is `MenuButton`'s job, and growing a second one here would mean a
 * second focus model, a second Escape handler and a second thing to get wrong
 * under `forced-colors`.
 */

export const SELECT_VARIANTS = ['form', 'filter'] as const;
export type SelectVariant = (typeof SELECT_VARIANTS)[number];

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: readonly SelectOption[];
  /** `filter` caps the control at `--size-menu`; a form field fills its field. */
  variant?: SelectVariant;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, variant = 'form', className, ...rest },
  ref,
) {
  return (
    <span className={styles.wrapper} data-variant={variant}>
      <select
        {...rest}
        ref={ref}
        className={cx(controlStyles.control, controlStyles.select, className)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size="sm" className={styles.chevron} />
    </span>
  );
});

/** The control's box while its options are in flight; same wrapper, same cap. */
export function SelectSkeleton({ variant = 'form' }: { variant?: SelectVariant }) {
  return (
    <span className={styles.wrapper} data-variant={variant}>
      <SkeletonBlock height="var(--size-touch-target)" />
    </span>
  );
}
