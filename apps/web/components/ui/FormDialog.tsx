'use client';

import { useId, type ReactNode } from 'react';
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
  /**
   * Blocks submit when the dialog has nothing valid to send — an assignee picker
   * with no assignees, say. For a *precondition the user cannot satisfy from
   * here*, not for field validation: an invalid value belongs in `Field`'s error
   * slot after a submit attempt, where it can be read, rather than behind a
   * button that silently will not press.
   */
  isSubmitDisabled?: boolean;
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
  isSubmitDisabled = false,
}: FormDialogProps) {
  const content = useContent();
  /*
   * The submit button lives in the modal footer, outside the `<form>`, so it is
   * associated by `form=` — and the id has to be **per instance**.
   *
   * A screen routinely *renders* several `FormDialog`s and opens one: `isOpen` is
   * a prop, not a mount, so every dialog on the screen is in the document at
   * once. A fixed id therefore appeared several times, and `form=` resolves to
   * the *first* element carrying it — so every dialog's submit button drove the
   * first dialog's form. The platform-admin tenant screen is where that surfaced
   * (TAR-804): pressing Reactivate submitted the Suspend dialog instead.
   */
  const formId = useId();

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
            form={formId}
            variant={submitVariant}
            isBlock
            isPending={isPending}
            disabled={isSubmitDisabled}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
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

function NOOP(): void {
  // Dismissal is blocked mid-submit: closing would abandon a request already sent.
}
