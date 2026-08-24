'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { FormError } from './FormError';
import { Modal, type ModalCloseReason } from './Modal';
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
 *
 * ## Not losing what the reader typed
 *
 * A dialog holding a form is a dialog holding work, and 0002 §1.4 gives it two
 * protections the `Modal` underneath cannot decide on its own:
 *
 * - **A press on the scrim does not dismiss it** — `kind="form"`. Escape and
 *   Cancel both still do, and both are deliberate in a way a pointer landing a
 *   few pixels wide of the panel is not.
 * - **Escape on a form the reader has typed into confirms first**, in a nested
 *   dialog of this app's own rather than a browser `confirm()`, which cannot be
 *   themed, translated or read in the same voice as the screen behind it.
 *
 * Only Escape asks. The close button and Cancel are controls that say what they
 * do, and putting a second dialog in front of a reader who pressed Cancel is the
 * interface arguing with them. A dialog with nothing typed into it — every
 * confirmation in the app — never sees the prompt at all.
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
  /** Renames the dismissal control where "Cancel" would be ambiguous. */
  cancelLabel?: string;
  /**
   * Off for a dialog that cannot hold unsaved work — the discard prompt this
   * component raises for itself, which is the one dialog that must not raise one.
   */
  guardsUnsavedInput?: boolean;
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
  cancelLabel,
  guardsUnsavedInput = true,
}: FormDialogProps) {
  const content = useContent();
  // Any edit at all, rather than a comparison against the initial values: a
  // field typed into and cleared again is still a reader who was working here,
  // and the cost of asking them once is a keystroke against losing the lot.
  const [hasUnsavedInput, setHasUnsavedInput] = useState(false);
  const [isDiscardPromptOpen, setIsDiscardPromptOpen] = useState(false);

  // A dialog that has just opened has nothing to lose yet — and these dialogs
  // are *rendered* closed rather than unmounted, so the state has to be cleared
  // on the way in rather than relying on a fresh mount.
  useEffect(() => {
    if (isOpen) {
      setHasUnsavedInput(false);
      setIsDiscardPromptOpen(false);
    }
  }, [isOpen]);

  function requestClose(reason: ModalCloseReason): void {
    if (guardsUnsavedInput && reason === 'escape' && hasUnsavedInput) {
      setIsDiscardPromptOpen(true);
      return;
    }

    onClose();
  }

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
    <>
      <Modal
        isOpen={isOpen}
        kind="form"
        onClose={isPending ? NOOP : requestClose}
        title={title}
        description={description}
        footer={
          <>
            <Button variant="secondary" isBlock onClick={onClose} disabled={isPending}>
              {cancelLabel ?? content.common.cancel}
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
          // Both, because they cover different controls: React's `onChange` is the
          // input event for text and the change event for a checkbox or a select,
          // and `onInput` catches anything that writes to a field without going
          // through a React handler at all.
          onInput={() => {
            setHasUnsavedInput(true);
          }}
          onChange={() => {
            setHasUnsavedInput(true);
          }}
        >
          <Stack gap="4">
            <FormError message={formError} requestId={requestId} />
            {children}
          </Stack>
        </form>
      </Modal>

      {/*
      A sibling rather than a child: a `<dialog>` inside this one's `<form>`
      would nest a second form inside the first, which is invalid HTML. The top
      layer does the stacking, so where it sits in the tree does not matter.
    */}
      {isDiscardPromptOpen ? (
        <FormDialog
          isOpen
          guardsUnsavedInput={false}
          title={content.common.discardTitle}
          description={content.common.discardDescription}
          submitLabel={content.common.discardConfirm}
          cancelLabel={content.common.keepEditing}
          submitVariant="danger"
          isPending={false}
          formError={null}
          onSubmit={() => {
            setIsDiscardPromptOpen(false);
            onClose();
          }}
          onClose={() => {
            setIsDiscardPromptOpen(false);
          }}
        >
          {null}
        </FormDialog>
      ) : null}
    </>
  );
}

function NOOP(): void {
  // Dismissal is blocked mid-submit: closing would abandon a request already sent.
}
