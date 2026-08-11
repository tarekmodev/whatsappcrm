'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Stack } from '@/components/layout/Stack';

/**
 * A real `<form>` with the error region and the submit button wired once. Usage:
 *
 * ```tsx
 * <AuthForm submitLabel={…} isPending={isPending} formError={formError} onSubmit={submit}>
 *   {fields}
 * </AuthForm>
 * ```
 *
 * The signed-out counterpart to `FormDialog`, which does the same job inside a
 * modal. Both screens under `(auth)/` use it, so neither can forget the pending
 * state, the double-submit guard or the announced error region.
 */
export function AuthForm({
  children,
  submitLabel,
  onSubmit,
  isPending,
  formError,
  requestId,
}: {
  children: ReactNode;
  submitLabel: string;
  onSubmit: () => void;
  isPending: boolean;
  formError: string | null;
  requestId?: string | null;
}) {
  return (
    <form
      noValidate
      onSubmit={(event) => {
        // Validation is the contract's; the submit is a browser fetch that has to
        // read the response's `Set-Cookie`, so the native POST is not what runs.
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
      </Stack>
    </form>
  );
}
