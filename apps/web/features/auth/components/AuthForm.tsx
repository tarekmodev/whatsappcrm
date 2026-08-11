'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Stack } from '@/components/layout/Stack';
import styles from './AuthForm.module.css';

/**
 * A page-level form with its error region, submit button and double-submit guard
 * wired once. Usage:
 *
 * ```tsx
 * <AuthForm submitLabel={…} isPending={isPending} formError={formError} onSubmit={submit}>
 *   {fields}
 * </AuthForm>
 * ```
 *
 * `FormDialog` is the same idea for a modal; this is the one for a form that owns
 * its screen. All three password screens use it, so none of them can forget the
 * pending state or leave a failure unannounced.
 *
 * The submit button is full width and at least a touch target tall, because on
 * every screen that uses this it is the only primary action on the page.
 */
export function AuthForm({
  children,
  submitLabel,
  onSubmit,
  isPending,
  formError,
  requestId,
  footer,
}: {
  children: ReactNode;
  submitLabel: string;
  onSubmit: () => void;
  isPending: boolean;
  formError: string | null;
  requestId?: string | null;
  /** Secondary navigation below the action, e.g. "Back to sign in". */
  footer?: ReactNode;
}) {
  return (
    <form
      noValidate
      className={styles.form}
      onSubmit={(event) => {
        // Validation is the contract's, and the submit is a server action.
        event.preventDefault();
        onSubmit();
      }}
    >
      <Stack gap="4">
        <FormError message={formError} requestId={requestId} />
        {children}
        <Button type="submit" variant="primary" isBlock isPending={isPending}>
          {submitLabel}
        </Button>
        {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
      </Stack>
    </form>
  );
}
