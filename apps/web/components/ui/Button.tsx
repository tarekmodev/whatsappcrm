'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Spinner } from './Spinner';
import { useContent } from '@/lib/content';
import styles from './Button.module.css';

/**
 * The one button in the app. Usage:
 * `<Button variant="primary" size="md" isPending={…}>Save changes</Button>`.
 *
 * `isPending` both disables the button and shows an in-place spinner — the only
 * place a spinner is allowed, per the loading rules; section content uses skeletons.
 */

/**
 * `danger` is the **solid** destructive control — a confirmation dialog's submit,
 * where it is the one thing the dialog exists for. `dangerQuiet` is that same
 * role at row weight: `--color-danger` text on a transparent ground, tinted on
 * hover and given a danger focus ring. A table whose rows each carried a solid
 * red button would make deletion the loudest thing on the page, which is the
 * opposite mistake to the one it fixes — see 0001's "Row actions".
 */
export const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger', 'dangerQuiet'] as const;
export const BUTTON_SIZES = ['sm', 'md'] as const;

export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];
export type ButtonSize = (typeof BUTTON_SIZES)[number];

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  isPending?: boolean;
  /**
   * What a screen reader hears while `isPending`. Defaults to the form layer's
   * "Saving…", which is right for a submit and wrong for anything else — an
   * export is preparing a file, not saving one. Overriding it keeps the
   * announcement inside the button rather than adding a second live region
   * beside it, which would say the same thing twice.
   *
   * On an `isBlock` button it is also shown on screen — see the note in the
   * component body for why the two presentations differ.
   */
  pendingLabel?: string;
  /** Renders at full width; used by the drawer and sheet layouts. */
  isBlock?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    variant = 'secondary',
    size = 'md',
    isPending = false,
    pendingLabel,
    isBlock = false,
    className,
    disabled,
    type = 'button',
    onClick,
    ...rest
  },
  ref,
) {
  const content = useContent();
  /*
   * A pending button normally hides its label and centres a spinner over it, so
   * the button keeps its width and the row around it does not shift. A **block**
   * button has no width to keep — it is already 100% — so it can afford to say
   * what it is doing, and on a screen whose fields have just been disabled it is
   * the only thing that can (TAR-521). Derived rather than another prop: the two
   * presentations differ for exactly this reason.
   */
  const isPendingLabelVisible = isBlock && pendingLabel !== undefined;

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx(styles.button, className)}
      data-variant={variant}
      data-size={size}
      data-block={isBlock ? 'true' : undefined}
      // A pending button keeps its place in the tab order and its accessible
      // name, so it is `aria-disabled` plus a click guard rather than `disabled`
      // — which would move focus to the body mid-submit.
      disabled={disabled}
      aria-disabled={isPending || disabled === true ? true : undefined}
      onClick={(event) => {
        if (isPending) {
          // Also stops a `type="submit"` from double-submitting the form.
          event.preventDefault();
          return;
        }

        onClick?.(event);
      }}
    >
      {isPending && isPendingLabelVisible ? (
        <span className={styles.label}>
          {/* The spinner already carries the label for assistive technology, so
              the copy beside it is decoration — otherwise the button says what it
              is doing twice. */}
          <Spinner label={pendingLabel} />
          <span aria-hidden="true">{pendingLabel}</span>
        </span>
      ) : (
        <>
          {isPending ? (
            <span className={styles.pending}>
              <Spinner label={pendingLabel ?? content.form.submitting} />
            </span>
          ) : null}
          <span className={styles.label} data-pending={isPending ? 'true' : undefined}>
            {children}
          </span>
        </>
      )}
    </button>
  );
});
