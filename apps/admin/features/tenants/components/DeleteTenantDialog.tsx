'use client';

import { useCallback, useState } from 'react';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Stack } from '@/components/layout/Stack';
import { TextInput } from '@/components/ui/TextInput';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { content } from '~/content/en';
import { deleteTenantAction } from '../tenants.actions';

/**
 * The most dangerous control in the product, treated like it (spec §2.5).
 *
 * Two modes in one dialog with **scheduled selected by default**: `Schedule
 * deletion` cancels with a grace period, reaches `suspended`, and purges on the
 * retention clock; `Delete immediately` sends `force: true`, which goes straight
 * to `suspended` with the purge clock moved to now.
 *
 * Choosing the immediate mode reveals a **type-to-confirm** field. It is the only
 * one in the product and it is justified: this is the single action that destroys
 * customer data on a clock the operator just shortened, and the API's own comment
 * frames it as a right-to-erasure path. The submit is disabled until the typed
 * slug matches — a disabled submit is permitted exactly here, because the reader
 * fixes it on this screen.
 *
 * The submit's verb changes with the mode, so the button never says something
 * milder than what pressing it does.
 */
export function DeleteTenantDialog({
  slug,
  name,
  isOpen,
  onClose,
}: {
  slug: string;
  name: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const [isImmediate, setIsImmediate] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');

  const isConfirmed = !isImmediate || confirmation.trim() === slug;

  const reset = useCallback(() => {
    setIsImmediate(false);
    setConfirmation('');
    setReason('');
  }, []);

  const { submit, isPending, formError, requestId, clearError } = useActionForm({
    perform: useCallback(
      async () => deleteTenantAction({ slug, force: isImmediate, reason }),
      [isImmediate, reason, slug],
    ),
    onSuccess: useCallback(
      ({ force }: { force: boolean }) => {
        showToast({
          tone: 'success',
          message: force ? content.writes.deletedNowToast(name) : content.writes.deletedToast(name),
        });
        reset();
        onClose();
      },
      [name, onClose, reset, showToast],
    ),
  });

  return (
    <FormDialog
      isOpen={isOpen}
      title={content.writes.deleteTitle}
      submitLabel={
        isImmediate ? content.writes.deleteImmediateSubmit : content.writes.deleteScheduledSubmit
      }
      submitVariant="danger"
      isSubmitDisabled={!isConfirmed}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onSubmit={submit}
      onClose={() => {
        clearError();
        reset();
        onClose();
      }}
    >
      <Stack gap="4">
        {/*
          A `Select` rather than a radio pair, because `components/ui` has no
          radio group and this story is not the place to add a shared primitive.
          The hint is the *selected* mode's explanation, which is what a radio
          pair would have shown against each option — the reader still gets the
          consequence of the mode they are on, wired to the control through
          `Field`'s `aria-describedby`.
        */}
        <Field
          label={content.writes.deleteModeLabel}
          hint={
            isImmediate ? content.writes.deleteImmediateHint : content.writes.deleteScheduledHint
          }
        >
          {({ controlId, describedBy }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              name="mode"
              value={isImmediate ? 'immediate' : 'scheduled'}
              options={[
                { value: 'scheduled', label: content.writes.deleteScheduled },
                { value: 'immediate', label: content.writes.deleteImmediate },
              ]}
              onChange={(event) => {
                setIsImmediate(event.target.value === 'immediate');
                // The confirmation belongs to the mode that asked for it: leaving
                // a matching slug behind would let a switch back to immediate
                // submit with no fresh confirmation at all.
                setConfirmation('');
              }}
            />
          )}
        </Field>

        {isImmediate ? (
          <>
            <Notice tone="danger">{content.writes.deleteImmediateWarning(name)}</Notice>
            <Field
              label={content.writes.deleteConfirmLabel}
              error={
                confirmation.length > 0 && !isConfirmed
                  ? content.writes.deleteConfirmMismatch
                  : undefined
              }
            >
              {({ controlId, describedBy, isInvalid }) => (
                <TextInput
                  id={controlId}
                  aria-describedby={describedBy}
                  aria-invalid={isInvalid}
                  name="confirmation"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={slug}
                  value={confirmation}
                  onChange={(event) => {
                    setConfirmation(event.target.value);
                  }}
                />
              )}
            </Field>
          </>
        ) : null}

        <Field label={content.writes.reasonLabel} hint={content.writes.reasonHint}>
          {({ controlId, describedBy }) => (
            <Textarea
              id={controlId}
              aria-describedby={describedBy}
              name="reason"
              rows={3}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          )}
        </Field>
      </Stack>
    </FormDialog>
  );
}
