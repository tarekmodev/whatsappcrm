'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Stack } from '@/components/layout/Stack';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { claimConversationAction, releaseConversationAction } from '@/features/inbox/inbox.actions';

/**
 * Takes a conversation, or puts it back. Usage:
 * `<ClaimButton conversationId={…} contactName={…} isMine={…} size="sm" />`.
 *
 * One component for both directions rather than two that differ by a verb: the
 * pending state, the double-submit guard, the toast and the inline failure are
 * identical, and two copies of them is how the release path quietly loses its
 * error handling.
 *
 * No confirmation dialog. Releasing is reversible in one click — claiming it
 * again — and a modal for a reversible action is friction, not safety.
 *
 * Rendered only for a principal holding `conversation:assign`. That check is the
 * caller's, and the action asserts it again: a server action is a public
 * endpoint, so a hidden button was never the gate.
 */

export interface ClaimButtonProps {
  conversationId: string;
  contactName: string;
  /** True when the signed-in user is already the assignee. */
  isMine: boolean;
  size?: 'sm' | 'md';
}

export function ClaimButton({
  conversationId,
  contactName,
  isMine,
  size = 'md',
}: ClaimButtonProps) {
  const content = useContent();
  const { showToast } = useToast();

  const onSuccess = useCallback(() => {
    showToast({
      tone: 'success',
      message: isMine
        ? content.inbox.releaseSuccess(contactName)
        : content.inbox.claimSuccess(contactName),
    });
  }, [contactName, content.inbox, isMine, showToast]);

  const { submit, isPending, formError, requestId } = useActionForm({
    perform: () =>
      isMine ? releaseConversationAction(conversationId) : claimConversationAction(conversationId),
    onSuccess,
  });

  return (
    <Stack gap="2">
      <Button
        variant={isMine ? 'secondary' : 'primary'}
        size={size}
        isPending={isPending}
        // The contact's name is in the accessible name, not only in the row
        // above it: a list of buttons all called "Claim" tells a screen-reader
        // user nothing about which conversation they are about to take.
        aria-label={
          isMine ? content.inbox.releaseAria(contactName) : content.inbox.claimAria(contactName)
        }
        onClick={submit}
      >
        {isMine ? content.inbox.release : content.inbox.claim}
      </Button>
      <FormError message={formError} requestId={requestId} />
    </Stack>
  );
}
