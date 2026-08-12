'use client';

import { useCallback } from 'react';
import type { ConversationStatus } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Icon } from '@/components/ui/Icon';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { setConversationStatusAction } from '@/features/inbox/inbox.actions';
import { useContextPanel } from './InboxLayout';
import styles from './ThreadActions.module.css';

/**
 * What an agent can do to the open conversation, beside its header. Usage:
 * `<ThreadActions conversationId={…} contactName={…} status={…} isUnclaimed={…} />`.
 *
 * Two controls, and both are real writes or real state:
 *
 *   * **Close / Reopen** — one `PATCH …/status` in either direction. No
 *     confirmation, because it is reversible by the very button that replaces
 *     it: a modal in front of an action you can undo in a click is friction
 *     dressed as safety. It is not offered on a thread nobody holds, because the
 *     API refuses it there for the same reason it refuses a send (TAR-186).
 *   * **Details** — shows and hides the context panel. A disclosure over a
 *     sibling region, so it points `aria-controls` at nothing it does not own
 *     and reports its state through `aria-expanded`.
 *
 * The reference layout also carries an overflow menu here. It is empty in this
 * product — everything that acts on a conversation is already one of the
 * controls on screen — and a `…` that opens nothing is worse than no `…`.
 */

export interface ThreadActionsProps {
  conversationId: string;
  contactName: string;
  status: ConversationStatus;
  /** Nobody holds this thread; the API refuses a status change on it. */
  isUnclaimed: boolean;
}

export function ThreadActions({
  conversationId,
  contactName,
  status,
  isUnclaimed,
}: ThreadActionsProps) {
  const content = useContent();

  return (
    <Cluster gap="2" align="center" className={styles.actions}>
      {isUnclaimed ? null : (
        <StatusButton conversationId={conversationId} contactName={contactName} status={status} />
      )}
      <DetailsToggle label={content.inbox.contextToggle} />
    </Cluster>
  );
}

function StatusButton({
  conversationId,
  contactName,
  status,
}: {
  conversationId: string;
  contactName: string;
  status: ConversationStatus;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const isClosed = status === 'closed';
  const next: ConversationStatus = isClosed ? 'open' : 'closed';

  const onSuccess = useCallback(() => {
    showToast({
      tone: 'success',
      message: isClosed
        ? content.inbox.reopenConversationSuccess(contactName)
        : content.inbox.closeConversationSuccess(contactName),
    });
  }, [contactName, content.inbox, isClosed, showToast]);

  const { submit, isPending, formError, requestId } = useActionForm({
    perform: () => setConversationStatusAction(conversationId, next),
    onSuccess,
  });

  return (
    <Stack gap="2">
      <Button variant="secondary" size="sm" isPending={isPending} onClick={submit}>
        {isClosed ? content.inbox.reopenConversation : content.inbox.closeConversation}
      </Button>
      <FormError message={formError} requestId={requestId} />
    </Stack>
  );
}

function DetailsToggle({ label }: { label: string }) {
  const content = useContent();
  const { isOpen, toggle } = useContextPanel();

  return (
    <button
      type="button"
      className={styles.toggle}
      aria-expanded={isOpen}
      title={label}
      onClick={toggle}
    >
      <Icon name="info" size="sm" />
      <VisuallyHidden>{isOpen ? content.inbox.contextHide : content.inbox.contextShow}</VisuallyHidden>
    </button>
  );
}
