'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Stack } from '@/components/layout/Stack';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { claimConversationAction, releaseConversationAction } from '@/features/inbox/inbox.actions';
import type { ConversationHold } from '@/features/inbox/conversation-hold';
import { LazyTakeOverDialog } from './inbox-dialogs.lazy';

/**
 * The one control that changes who holds a conversation. Usage:
 * `<ClaimButton conversationId={…} contactName={…} hold={…} size="sm" />`.
 *
 * Three states, one per branch of `ConversationHold`, and the third is the
 * reason this is not a boolean:
 *
 *   * **unclaimed** — "Claim". Nobody is holding it; taking it out of the shared
 *     pool needs no ceremony. `conversation:claim`, which every role holds.
 *   * **mine** — "Release". Reversible in one click, so no confirmation: a modal
 *     for a reversible action is friction, not safety.
 *   * **theirs** — "Take over", behind a confirmation that names the colleague
 *     and says what it costs them. A *different write* from the claim since
 *     TAR-186: the claim compares and sets, so it refuses a thread somebody
 *     already holds, while a take-over is the blind assignment — which is the
 *     whole point of it, and why it needs the confirmation instead.
 *
 * Rendered by a caller that has checked `canChangeHold` — `conversation:claim`
 * for the first state, `conversation:assign` for the other two. The actions
 * assert the same permissions again: a server action is a public endpoint, so a
 * hidden button was never the gate.
 */

export interface ClaimButtonProps {
  conversationId: string;
  contactName: string;
  hold: ConversationHold;
  size?: 'sm' | 'md';
  /**
   * The loudest this control may be. A thread header's claim is that screen's
   * primary action and takes the accent; a list row's is capped at `quiet`,
   * because a solid accent button repeated down a column outnumbers — and
   * out-shouts — the one action the screen is actually about (0001, TAR-517).
   *
   * It only ever caps: releasing and taking over are `secondary` either way.
   */
  emphasis?: 'accent' | 'quiet';
}

export function ClaimButton({
  conversationId,
  contactName,
  hold,
  size = 'md',
  emphasis = 'accent',
}: ClaimButtonProps) {
  if (hold.state === 'theirs') {
    return (
      <TakeOverControl
        conversationId={conversationId}
        contactName={contactName}
        holderName={hold.holderName}
        size={size}
      />
    );
  }

  return (
    <ClaimOrReleaseControl
      conversationId={conversationId}
      contactName={contactName}
      isMine={hold.state === 'mine'}
      size={size}
      emphasis={emphasis}
    />
  );
}

/**
 * The two directions that need no confirmation. One component rather than two
 * that differ by a verb: the pending state, the double-submit guard, the toast
 * and the inline failure are identical, and two copies of them is how the
 * release path quietly loses its error handling.
 */
function ClaimOrReleaseControl({
  conversationId,
  contactName,
  isMine,
  size,
  emphasis,
}: {
  conversationId: string;
  contactName: string;
  isMine: boolean;
  size: 'sm' | 'md';
  emphasis: 'accent' | 'quiet';
}) {
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
        variant={isMine || emphasis === 'quiet' ? 'secondary' : 'primary'}
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

/** Opens the confirmation; the dialog owns the write, its chunk and its errors. */
function TakeOverControl({
  conversationId,
  contactName,
  holderName,
  size,
}: {
  conversationId: string;
  contactName: string;
  holderName: string | null;
  size: 'sm' | 'md';
}) {
  const content = useContent();
  const [isConfirming, setIsConfirming] = useState(false);
  // A holder whose id did not resolve still has to be named in the copy, or the
  // sentence reads "is handling" with nobody doing it.
  const holderLabel = holderName ?? content.inbox.unresolvedHolder;

  return (
    <>
      <Button
        variant="secondary"
        size={size}
        aria-label={content.inbox.takeOverAria(contactName, holderLabel)}
        onClick={() => {
          setIsConfirming(true);
        }}
      >
        {content.inbox.takeOver}
      </Button>
      {isConfirming ? (
        <LazyTakeOverDialog
          conversationId={conversationId}
          contactName={contactName}
          holderLabel={holderLabel}
          onClose={() => {
            setIsConfirming(false);
          }}
        />
      ) : null}
    </>
  );
}
