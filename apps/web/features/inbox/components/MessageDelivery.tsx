'use client';

import { useCallback } from 'react';
import type { MessageResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Icon } from '@/components/ui/Icon';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { sendMessageAction } from '@/features/inbox/composer.actions';
import { useIdempotencyKey } from '@/features/inbox/useIdempotencyKey';
import { DELIVERY_ICONS, canRetrySend } from '@/features/inbox/delivery-state';
import styles from './MessageDelivery.module.css';

/**
 * Whether an outbound message reached the customer, at the bubble's trailing
 * edge. Usage: `<MessageDelivery message={message} contactName={…} />`, rendered
 * by `MessageBubble` for outbound messages only.
 *
 * ## The failure is on the message, not in a toast
 *
 * A send that fails while the agent is looking at the composer already raises a
 * toast, and a toast is gone in seconds — so a thread opened an hour later showed
 * a bubble that looked sent and was not. The state has been on
 * `MessageResponse.status` since TAR-20; this is the treatment it was missing.
 *
 * Retry re-sends the same text through the ordinary send path with a fresh
 * idempotency key, so it is one message to the customer and the API's replay
 * guard still catches a double click. A failure this console cannot rebuild —
 * anything carrying media — says how to send it instead of offering a button
 * that would drop the file (`canRetrySend`).
 */

export interface MessageDeliveryProps {
  message: MessageResponse;
  /** Named in the retry's accessible name, so it says which customer. */
  contactName: string;
}

export function MessageDelivery({ message, contactName }: MessageDeliveryProps) {
  const content = useContent();
  const isFailed = message.status === 'failed';

  return (
    <div className={styles.delivery} data-status={message.status}>
      <p className={styles.state}>
        <Icon name={DELIVERY_ICONS[message.status]} size="sm" />
        {/* The icon is decorative; this is the word that says which state it is,
            and the hidden prefix is what makes it a sentence rather than a
            loose adjective in the middle of the bubble. */}
        <VisuallyHidden>
          {content.thread.deliveryState(content.messageStatuses[message.status])}
        </VisuallyHidden>
        <span aria-hidden="true">{content.messageStatuses[message.status]}</span>
      </p>

      {isFailed ? <FailureDetail message={message} contactName={contactName} /> : null}
    </div>
  );
}

/**
 * Meta's own reason for the refusal, and the way back from it. Split out because
 * it is the only branch with a write in it — the state line above is a pure
 * render on every other message in the thread.
 */
function FailureDetail({ message, contactName }: MessageDeliveryProps) {
  const content = useContent();

  return (
    <div className={styles.failure}>
      {message.failureReason === null ? null : (
        <p className={styles.reason}>{content.thread.failureReason(message.failureReason)}</p>
      )}

      {canRetrySend(message) ? (
        <RetryButton message={message} contactName={contactName} />
      ) : (
        <p className={styles.reason}>{content.thread.retryUnavailable}</p>
      )}
    </div>
  );
}

function RetryButton({ message, contactName }: MessageDeliveryProps) {
  const content = useContent();
  const { showToast } = useToast();
  const { keyFor, retire } = useIdempotencyKey();
  const body = message.body?.trim() ?? '';

  const onSuccess = useCallback(() => {
    // The key that carried this attempt is spent. Left in place, a second retry
    // of the identical text would replay this response and never reach the
    // customer — see `useIdempotencyKey`.
    retire();
    showToast({ tone: 'success', message: content.thread.retrySendSuccess });
  }, [content.thread.retrySendSuccess, retire, showToast]);

  const { submit, isPending, formError, requestId } = useActionForm({
    perform: () => {
      const input = { type: 'text', body } as const;

      return sendMessageAction(message.conversationId, keyFor(JSON.stringify(input)), input);
    },
    onSuccess,
  });

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        isPending={isPending}
        aria-label={content.thread.retrySendAria(contactName)}
        onClick={submit}
      >
        {content.thread.retrySend}
      </Button>
      <FormError message={formError} requestId={requestId} />
    </>
  );
}
