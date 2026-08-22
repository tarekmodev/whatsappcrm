'use client';

import { useCallback, useState } from 'react';
import type { CannedResponseResponse, CannedResponseUpdateInput } from '@whatsappcrm/contracts';
import { FormDialog } from '@/components/ui/FormDialog';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { updateCannedResponseAction } from '../canned-responses.actions';
import type { CannedResponseDraft } from '../canned-response-form';
import { useCannedResponseDraft } from '../useCannedResponseDraft';
import { CannedResponseFields } from './CannedResponseFields';

/**
 * Edits a saved reply. Usage:
 * `<EditCannedResponseDialog response={response} onClose={…} />`.
 *
 * All three fields are offered, unlike a custom field's immutable key: a
 * shortcut is what an agent types in the moment, not what a stored value is
 * filed under, so renaming one breaks nothing that outlives the keystroke. A
 * message an agent already sent carries its own copy of the text and is not
 * touched.
 *
 * Only what changed is sent. `CannedResponseUpdateInputSchema` is the create
 * input partial, and writing all three back would clobber a colleague's edit to
 * the field this dialog did not touch — which on a library the whole workspace
 * shares is not a hypothetical.
 */
export function EditCannedResponseDialog({
  response,
  onClose,
}: {
  response: CannedResponseResponse;
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  // The row's values, captured once. Re-deriving them from the prop on every
  // render would throw away what the admin has typed the moment the realtime
  // subscription re-renders the table behind the dialog.
  const [initial] = useState<CannedResponseDraft>(() => ({
    shortcut: response.shortcut,
    title: response.title,
    body: response.body,
  }));
  const form = useCannedResponseDraft(initial);
  const { cleaned, validate } = form;

  const patch = changedFields(response, cleaned);

  const perform = useCallback(async () => {
    return updateCannedResponseAction(response.id, changedFields(response, cleaned));
  }, [cleaned, response]);

  const onSuccess = useCallback(
    ({ title }: { title: string }) => {
      showToast({ tone: 'success', message: content.cannedResponses.editSuccess(title) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.cannedResponses.editTitle(response.title)}
      submitLabel={content.common.save}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      // Nothing changed is not an error to report — the update schema refuses an
      // empty body, and there is nothing here for the admin to fix.
      isSubmitDisabled={Object.keys(patch).length === 0}
      onClose={onClose}
      onSubmit={() => {
        if (validate()) {
          submit();
        }
      }}
    >
      <CannedResponseFields form={form} isDisabled={isPending} />
    </FormDialog>
  );
}

/** Only what differs from the saved row. */
function changedFields(
  response: CannedResponseResponse,
  cleaned: CannedResponseDraft,
): CannedResponseUpdateInput {
  const patch: CannedResponseUpdateInput = {};

  if (cleaned.shortcut !== response.shortcut) {
    patch.shortcut = cleaned.shortcut;
  }

  if (cleaned.title !== response.title) {
    patch.title = cleaned.title;
  }

  if (cleaned.body !== response.body) {
    patch.body = cleaned.body;
  }

  return patch;
}
