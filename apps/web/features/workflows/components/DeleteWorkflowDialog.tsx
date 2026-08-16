'use client';

import { useCallback } from 'react';
import type { WorkflowResponse } from '@whatsappcrm/contracts';
import { FormDialog } from '@/components/ui/FormDialog';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { deleteWorkflowAction } from '../workflows.actions';

/**
 * Confirms deleting a workflow. Usage:
 * `<DeleteWorkflowDialog workflow={workflow} onClose={…} />`.
 *
 * Confirmed rather than offered as an undo, because there is nothing to undo it
 * with: the API has no restore, and a workflow is a standing instruction that
 * writes to real tickets. The copy names it and says what does *not* change —
 * tickets it already changed keep those changes — rather than asking "are you
 * sure?".
 */
export function DeleteWorkflowDialog({
  workflow,
  onClose,
}: {
  workflow: WorkflowResponse;
  onClose: () => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const { showToast } = useToast();

  const perform = useCallback(async () => {
    return deleteWorkflowAction(workflow.id, workflow.name);
  }, [workflow.id, workflow.name]);

  const onSuccess = useCallback(
    ({ name }: { name: string }) => {
      showToast({ tone: 'success', message: copy.deleteSuccess(name) });
      onClose();
    },
    [copy, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={copy.deleteWorkflowTitle}
      submitLabel={copy.deleteWorkflowConfirm}
      submitVariant="danger"
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={submit}
    >
      <p>{copy.deleteWorkflowBody(workflow.name)}</p>
    </FormDialog>
  );
}
