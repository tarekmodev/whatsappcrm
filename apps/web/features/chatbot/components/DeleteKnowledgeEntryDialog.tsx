'use client';

import { useCallback } from 'react';
import type { KnowledgeDocumentResponse } from '@whatsappcrm/contracts';
import { FormDialog } from '@/components/ui/FormDialog';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { deleteKnowledgeEntryAction } from '../chatbot.actions';

/**
 * Confirms deleting a knowledge base entry. Usage:
 * `<DeleteKnowledgeEntryDialog document={document} isLastIndexedEntry onClose={…} />`.
 *
 * Confirmed rather than offered as an undo, because there is nothing to undo it
 * with: the API has no restore, and the entry's text is something a person
 * wrote.
 *
 * **The warning changes when this is the last usable entry**, and that is the
 * reason this dialog exists rather than a generic confirm. Deleting the last
 * indexed entry switches automated replies off for the whole workspace — ADR
 * 0010's empty-knowledge-base rule is structural, so the chatbot simply goes
 * quiet — and an admin who was not told would read the silence as a fault.
 */
export function DeleteKnowledgeEntryDialog({
  document,
  isLastIndexedEntry,
  onClose,
}: {
  document: KnowledgeDocumentResponse;
  isLastIndexedEntry: boolean;
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();

  const perform = useCallback(async () => {
    return deleteKnowledgeEntryAction(document.id, document.title);
  }, [document.id, document.title]);

  const onSuccess = useCallback(
    ({ title }: { title: string }) => {
      showToast({ tone: 'success', message: content.chatbot.deleteSuccess(title) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.chatbot.deleteTitle}
      submitLabel={content.chatbot.deleteConfirm}
      submitVariant="danger"
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={submit}
    >
      <p>
        {isLastIndexedEntry
          ? content.chatbot.deleteLastBody(document.title)
          : content.chatbot.deleteBody(document.title)}
      </p>
    </FormDialog>
  );
}
