'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Stack } from '@/components/layout/Stack';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { takeOverFromBotAction } from '@/features/inbox/inbox.actions';

/**
 * Stops the chatbot answering this conversation. Usage:
 * `<TakeFromBotButton conversationId={…} contactName={…} />`, rendered only
 * while `canRequestHandoff(conversation.botState)`.
 *
 * No confirmation, deliberately. Every other control that changes who holds a
 * thread either costs a colleague their work — the take-over, which is
 * confirmed — or is reversible in a click. This one is neither: it takes work
 * from a machine, and the worst case is that a person answers a question the
 * chatbot could have. That is the safe direction, and a modal in front of it
 * would be friction rather than safety.
 *
 * It is **not** reversible, and the copy on the thread says so: the chatbot does
 * not resume in a conversation a human has taken (ADR 0010, decision 5). The
 * reason it is terminal is worth more than the undo — a bot that resumed after
 * an agent had spoken would talk over a colleague in front of the customer.
 */
export function TakeFromBotButton({
  conversationId,
  contactName,
  size = 'md',
  emphasis = 'accent',
}: {
  conversationId: string;
  contactName: string;
  size?: 'sm' | 'md';
  /**
   * The loudest this control may be, capped by the caller — the same prop and
   * the same reason `ClaimButton` has one.
   *
   * A thread header draws exactly one solid accent button, and on an *unclaimed*
   * thread the chatbot is answering, that button is `Claim`: stopping the bot
   * writes nothing about who holds the conversation (`POST …/handoff` is a
   * handoff, not an assignment), so the agent still could not reply afterwards.
   * `threadState` is where that order is decided.
   */
  emphasis?: 'accent' | 'quiet';
}) {
  const content = useContent();
  const { showToast } = useToast();

  const perform = useCallback(async () => takeOverFromBotAction(conversationId), [conversationId]);

  const onSuccess = useCallback(
    ({ contactName: name }: { contactName: string }) => {
      showToast({ tone: 'success', message: content.inbox.takeFromBotSuccess(name) });
    },
    [content, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <Stack gap="2">
      <Button
        variant={emphasis === 'accent' ? 'primary' : 'secondary'}
        size={size}
        isPending={isPending}
        // The contact's name is in the accessible name, not only in the header
        // above it: a screen-reader user moving by button hears which
        // conversation they are taking.
        aria-label={content.inbox.takeFromBotAria(contactName)}
        onClick={submit}
      >
        {content.inbox.takeFromBot}
      </Button>
      <FormError message={formError} requestId={requestId} />
    </Stack>
  );
}
