'use client';

import { useCallback } from 'react';
import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import { FormDialog } from '@/components/ui/FormDialog';
import { Notice } from '@/components/ui/Notice';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { deleteCannedResponseAction } from '../canned-responses.actions';

/**
 * Confirms deleting a saved reply. Usage:
 * `<DeleteCannedResponseDialog response={response} onClose={…} />`.
 *
 * The copy names **what stops working** rather than asking "are you sure": the
 * shortcut stops inserting anything, for every agent in the workspace, at once.
 * It also says what is *not* lost — a message already sent carries its own copy
 * of the text — because the fear that stops an admin tidying a stale library is
 * that deleting a reply rewrites history.
 *
 * A confirmation rather than a toast with an Undo, because there is no undo to
 * offer: the API has no restore route, and an optimistic success this dialog
 * could not roll back would be worse than the extra click.
 */
export function DeleteCannedResponseDialog({
  response,
  onClose,
}: {
  response: CannedResponseResponse;
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();

  const perform = useCallback(async () => {
    return deleteCannedResponseAction(response.id, response.title);
  }, [response.id, response.title]);

  const onSuccess = useCallback(
    ({ title }: { title: string }) => {
      showToast({ tone: 'success', message: content.cannedResponses.removeSuccess(title) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.cannedResponses.removeTitle(response.title)}
      submitLabel={content.cannedResponses.removeConfirm}
      submitVariant="danger"
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={submit}
    >
      <Notice tone="warning">
        {content.cannedResponses.removeBody(response.title, response.shortcut)}
      </Notice>
    </FormDialog>
  );
}
