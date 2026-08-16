'use client';

import { useCallback } from 'react';
import type { CustomFieldDefinition } from '@whatsappcrm/contracts';
import { FormDialog } from '@/components/ui/FormDialog';
import { Notice } from '@/components/ui/Notice';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { deleteCustomFieldAction } from '../custom-fields.actions';

/**
 * Confirms deleting a custom field. Usage:
 * `<DeleteCustomFieldDialog definition={definition} onClose={…} />`.
 *
 * The copy names **exactly what is lost**, rather than asking "are you sure":
 * the API strips the key from every contact in the tenant in the same
 * transaction, so this is not "the field stops appearing", it is "every value
 * anyone ever typed into it is deleted". There is no undo to offer, which is why
 * this is a confirmation rather than a toast with an Undo.
 *
 * A refusal is not always a failure worth generic copy: the API answers
 * `conflict` when a routing rule names the key and lists the rules in the error,
 * and `conflict` is in `ACTIONABLE_ERROR_CODES` — so the admin reads which rule
 * is in the way and can disable it and retry.
 */
export function DeleteCustomFieldDialog({
  definition,
  onClose,
}: {
  definition: CustomFieldDefinition;
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();

  const perform = useCallback(async () => {
    return deleteCustomFieldAction(definition.id, definition.label);
  }, [definition.id, definition.label]);

  const onSuccess = useCallback(
    ({ label }: { label: string }) => {
      showToast({ tone: 'success', message: content.customFields.removeSuccess(label) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.customFields.removeTitle}
      submitLabel={content.customFields.removeConfirm}
      submitVariant="danger"
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={submit}
    >
      <Notice tone="warning">{content.customFields.removeBody(definition.label)}</Notice>
    </FormDialog>
  );
}
