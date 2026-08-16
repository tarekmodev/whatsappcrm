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

export const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const;
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
      {isPending ? (
        <span className={styles.pending}>
          <Spinner label={pendingLabel ?? content.form.submitting} />
        </span>
      ) : null}
      <span className={styles.label} data-pending={isPending ? 'true' : undefined}>
        {children}
      </span>
    </button>
  );
});
