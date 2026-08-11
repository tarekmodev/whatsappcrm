'use client';

import type { ReactNode } from 'react';
import { Button } from './Button';
import { FormError } from './FormError';
import { Modal } from './Modal';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';

/**
 * A dialog wrapping a real `<form>`, with the submit/cancel row and the form-level
 * error slot wired once. Usage:
 *
 * ```tsx
 * <FormDialog title={…} submitLabel={…} onSubmit={submit} onClose={onClose}
 *             isPending={isPending} formError={formError}>
 *   {fields}
 * </FormDialog>
 * ```
 *
 * Every dialog in the People surface uses this, so none of them can forget the
 * pending state, the double-submit guard or the error region.
 */

export interface FormDialogProps {
  isOpen: boolean;
  title: string;
  submitLabel: string;
  children: ReactNode;
  onSubmit: () => void;
  onClose: () => void;
  isPending: boolean;
  formError: string | null;
  requestId?: string | null;
  description?: string;
  /** `danger` for a destructive confirmation. */
  submitVariant?: 'primary' | 'danger';
}

export function FormDialog({
  isOpen,
  title,
  submitLabel,
  children,
  onSubmit,
  onClose,
  isPending,
  formError,
  requestId,
  description,
  submitVariant = 'primary',
}: FormDialogProps) {
  const content = useContent();

  return (
    <Modal
      isOpen={isOpen}
      onClose={isPending ? NOOP : onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" isBlock onClick={onClose} disabled={isPending}>
            {content.common.cancel}
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            variant={submitVariant}
            isBlock
            isPending={isPending}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => {
          // Validation is the contract's, and the submit is a server action.
          event.preventDefault();
          onSubmit();
        }}
      >
        <Stack gap="4">
          <FormError message={formError} requestId={requestId} />
          {children}
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * The submit button lives in the modal footer, outside the form element, so it is
 * associated by `form=`. A fixed id is safe because only one dialog is ever open.
 */
const FORM_ID = 'form-dialog';

function NOOP(): void {
  // Dismissal is blocked mid-submit: closing would abandon a request already sent.
}
