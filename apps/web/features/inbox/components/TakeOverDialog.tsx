'use client';

import { useCallback } from 'react';
import { FormDialog } from '@/components/ui/FormDialog';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { claimConversationAction } from '@/features/inbox/inbox.actions';

/**
 * Confirms taking a conversation off the colleague handling it. Usage:
 * `<TakeOverDialog conversationId={…} contactName={…} holderLabel={…} onClose={…} />`.
 *
 * Not reversible from the UI in any useful sense — the previous holder cannot
 * take it back without doing this to *you* — so it is confirmed rather than
 * offered as an undo, and the confirmation names the person and states exactly
 * what happens, rather than asking "are you sure?".
 *
 * Since TAR-198 the hand-over reaches that person's inbox live — the relay
 * addresses `conversation.updated` to the previous audience as well as the new
 * one, precisely so the agent who just lost a thread finds out. What still does
 * not exist is a notification: nothing interrupts them, and they may be part-way
 * through a reply. The copy says that rather than the older, blunter "they are
 * not told", which stopped being true when the emit landed.
 */
export function TakeOverDialog({
  conversationId,
  contactName,
  holderLabel,
  onClose,
}: {
  conversationId: string;
  contactName: string;
  /** The holder's display name, or the content layer's stand-in for an unresolved one. */
  holderLabel: string;
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();

  const perform = useCallback(
    async () => claimConversationAction(conversationId),
    [conversationId],
  );

  const onSuccess = useCallback(() => {
    showToast({
      tone: 'success',
      message: content.inbox.takeOverSuccess(contactName, holderLabel),
    });
    onClose();
  }, [contactName, content.inbox, holderLabel, onClose, showToast]);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.inbox.takeOverTitle}
      submitLabel={content.inbox.takeOverConfirm}
      submitVariant="danger"
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={submit}
    >
      <p>{content.inbox.takeOverBody(contactName, holderLabel)}</p>
    </FormDialog>
  );
}
