'use client';

import { useRef } from 'react';
import { Field } from './Field';
import { Icon } from './Icon';
import { SkeletonBlock } from './Skeleton';
import { TextInput } from './TextInput';
import { useContent } from '@/lib/content';
import { cx } from '@/lib/cx';
import styles from './SearchField.module.css';

/**
 * The search box in a list view's filter row. Usage:
 * `<SearchField label="Search agents" value={draft} onChange={setDraft} />`.
 *
 * 0001's filter-row rule (TAR-516): a leading search icon, a label that is
 * present even when it is only for screen readers, a clear affordance once there
 * is something to clear, and a cap at `--size-container-sm` — a text box a
 * thousand pixels wide reads as a form field rather than as a filter.
 *
 * Uncontrolled-looking but controlled: the caller owns the draft, because the
 * filter it drives lives in the URL and the box has to follow the back button.
 * Clearing returns focus to the input, so a keyboard user who empties the box is
 * left where they can type again rather than on a button that just disappeared.
 */

export interface SearchFieldProps {
  /** Names the control: "Search agents", not "Search". */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Shows the label above the box. Off by default — a filter's intent is visual. */
  isLabelVisible?: boolean;
  placeholder?: string;
  /** The query parameter this box drives, for a browser's form autofill. */
  name?: string;
  className?: string;
}

export function SearchField({
  label,
  value,
  onChange,
  isLabelVisible = false,
  placeholder,
  name = 'q',
  className,
}: SearchFieldProps) {
  const content = useContent();
  const inputRef = useRef<HTMLInputElement>(null);
  const hasValue = value !== '';

  return (
    <div className={cx(styles.field, className)}>
      <Field label={label} isLabelHidden={!isLabelVisible}>
        {({ controlId }) => (
          <div className={styles.control}>
            <Icon name="search" size="sm" className={styles.leadingIcon} />
            <TextInput
              ref={inputRef}
              id={controlId}
              type="search"
              name={name}
              autoComplete="off"
              placeholder={placeholder}
              value={value}
              className={styles.input}
              data-has-value={hasValue ? 'true' : 'false'}
              onChange={(event) => {
                onChange(event.target.value);
              }}
            />
            {hasValue ? (
              <button
                type="button"
                className={styles.clear}
                aria-label={content.common.clearSearch}
                onClick={() => {
                  onChange('');
                  inputRef.current?.focus();
                }}
              >
                <Icon name="close" size="sm" />
              </button>
            ) : null}
          </div>
        )}
      </Field>
    </div>
  );
}

/**
 * The box, before whatever the filter row is waiting for arrives. Same wrapper
 * and the same width cap as the real control, and `--size-touch-target` is what
 * `Control.module.css` resolves a control's height to — so the swap moves nothing.
 */
export function SearchFieldSkeleton() {
  return (
    <div className={styles.field}>
      <SkeletonBlock height="var(--size-touch-target)" />
    </div>
  );
}
