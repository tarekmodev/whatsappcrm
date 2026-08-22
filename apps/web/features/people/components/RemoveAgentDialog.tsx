'use client';

import { useCallback } from 'react';
import type { UserResponse } from '@whatsappcrm/contracts';
import { FormDialog } from '@/components/ui/FormDialog';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { removeAgentAction } from '../people.actions';

/**
 * Confirms removing an agent. Usage:
 * `<RemoveAgentDialog user={user} onClose={…} />`.
 *
 * Removal is not reversible from the UI, so it is confirmed rather than offered as
 * an undo — and the confirmation names the person and states exactly what happens
 * to their conversations, rather than asking "are you sure?".
 */
export function RemoveAgentDialog({ user, onClose }: { user: UserResponse; onClose: () => void }) {
  const content = useContent();
  const { showToast } = useToast();

  const perform = useCallback(async () => {
    return removeAgentAction(user.id, user.displayName);
  }, [user.displayName, user.id]);

  const onSuccess = useCallback(
    ({ displayName }: { displayName: string }) => {
      showToast({ tone: 'success', message: content.people.removeSuccess(displayName) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.people.removeAgentTitle(user.displayName)}
      submitLabel={content.people.removeAgentConfirm}
      submitVariant="danger"
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={submit}
    >
      <p>{content.people.removeAgentBody(user.displayName)}</p>
    </FormDialog>
  );
}
