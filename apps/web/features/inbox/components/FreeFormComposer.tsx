'use client';

import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { CannedResponseResponse, SendMediaInput, SendTextInput } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Icon } from '@/components/ui/Icon';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { SkeletonBlock, SkeletonLine } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { sendMessageAction } from '@/features/inbox/composer.actions';
import { useIdempotencyKey } from '@/features/inbox/useIdempotencyKey';
import {
  ATTACHABLE_MEDIA_KINDS,
  EMPTY_ATTACHMENT,
  type ComposerAttachmentValue,
} from '@/features/inbox/media-draft';
import {
  buildFreeFormSend,
  freeFormMaxLength,
  type FreeFormProblem,
} from '@/features/inbox/free-form-draft';
import { ComposerAttachment, ComposerAttachmentSkeleton } from './ComposerAttachment';
import { ReplyDraftField } from './ReplyDraftField';
import styles from './MessageComposer.module.css';

/**
 * The free-form half of the composer: a message the agent writes themselves,
 * optionally carrying one file. Usage:
 * `<FreeFormComposer conversationId={id} isWindowOpen={…} windowHint={…} templateAction={…} />`.
 *
 * A real `<form>` with a real submit, like the note form beside it. The draft is
 * cleared only on success — a failed send must never make somebody retype a
 * reply — and the field is refocused afterwards, because an agent who sent one
 * message usually sends another.
 *
 * ## The box, then one toolbar under it
 *
 * Before TAR-518 this was five stacked blocks — a two-line banner, a labelled
 * textarea with a hint, a labelled file input, a status line and a right-aligned
 * Send — about 630px of composer over a message stream that had been squeezed to
 * a quarter of the column. Everything that is not the writing surface is now one
 * row beneath it: attachments and the template picker at the leading edge, the
 * service-window countdown and Send at the trailing one.
 *
 * ## Disabled, not hidden, outside the window
 *
 * When the service window shuts the controls go inert and the draft stays put.
 * Removing the box would throw away what was typed and leave the agent guessing
 * why; the hint in the toolbar says what happened, and the template picker beside
 * it is the way through.
 *
 * ## One file, and it is already uploaded
 *
 * WhatsApp carries one media object per message, so this holds one. What that
 * does to the send — a media type, a shorter ceiling, the text becoming a
 * caption — is `buildFreeFormSend`'s to decide, not this form's.
 *
 * ## Canned responses are the field's, not the form's
 *
 * Typing `/hours` inserts a saved reply into the draft (TAR-484). That is
 * `ReplyDraftField`'s whole job; from here it is an ordinary draft change, which
 * is exactly what the acceptance criterion asks for — the inserted text is
 * editable, and the only thing that sends it is the button below.
 */
export function FreeFormComposer({
  conversationId,
  isWindowOpen,
  cannedResponses,
  windowHint,
  templateAction,
}: {
  conversationId: string;
  isWindowOpen: boolean;
  /** The tenant's shortcut library. Empty means the field shows no picker. */
  cannedResponses: readonly CannedResponseResponse[];
  /** The service-window countdown, inline at the toolbar's trailing edge. */
  windowHint: ReactNode;
  /** The template picker's trigger — the way through once the window has shut. */
  templateAction: ReactNode;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const { keyFor, retire } = useIdempotencyKey();
  const [body, setBody] = useState('');
  const [attachment, setAttachment] = useState<ComposerAttachmentValue>(EMPTY_ATTACHMENT);
  const [problem, setProblem] = useState<FreeFormProblem | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Read by `perform`, which `useActionForm` calls after the click. Held in a
  // ref so the payload the guard validated is exactly the one that is sent.
  const pendingRef = useRef<SendTextInput | SendMediaInput | null>(null);

  const onSuccess = useCallback(() => {
    // Before anything else: the key that carried this message is spent. Left in
    // place, the identical reply an agent sends two minutes later would reuse
    // it, replay this send's response, and never reach the customer.
    retire();
    setBody('');
    // The control the agent can see follows this into the empty state, so
    // re-picking the same file still starts an upload (`useMediaUpload`).
    setAttachment(EMPTY_ATTACHMENT);
    showToast({ tone: 'success', message: content.composer.sendSuccess });
    textareaRef.current?.focus();
  }, [content.composer.sendSuccess, retire, showToast]);

  const { submit, isPending, formError, requestId } = useActionForm({
    perform: () => {
      const input = pendingRef.current;

      if (input === null) {
        // Unreachable: `onSubmit` sets this before calling `submit`. Refused
        // rather than sent as something invented, because the alternative is a
        // message to a customer that nobody composed.
        return Promise.resolve({
          status: 'error' as const,
          message: content.form.genericSubmitError,
          requestId: null,
        });
      }

      return sendMessageAction(conversationId, keyFor(JSON.stringify(input)), input);
    },
    onSuccess,
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const build = buildFreeFormSend(body, attachment);

    if (build.outcome === 'incomplete') {
      setProblem(build.problem);
      textareaRef.current?.focus();
      return;
    }

    setProblem(null);
    pendingRef.current = build.input;
    submit();
  };

  // Assigning the content object to the exhaustive record is the check: a new
  // `FreeFormProblem` without a line of copy fails the build here.
  const problemMessages: Record<FreeFormProblem, string> = content.composer.problems;
  const maxLength = freeFormMaxLength(attachment);

  return (
    <form onSubmit={onSubmit} noValidate>
      <Stack gap="2">
        <ReplyDraftField
          value={body}
          onChange={setBody}
          textareaRef={textareaRef}
          cannedResponses={cannedResponses}
          rows={TEXTAREA_ROWS}
          maxLength={maxLength}
          isExpanded={isExpanded}
          isDisabled={!isWindowOpen}
          error={problem === null ? undefined : problemMessages[problem]}
          isRequired={attachment.status !== 'ready'}
        />

        {/* Above the toolbar, not in a toast: a send that failed is the reason
            the draft is still on screen, and the reader is looking at the box. */}
        <FormError message={formError} requestId={requestId} />

        <div className={styles.toolbar} role="group" aria-label={content.composer.toolbarLabel}>
          <Cluster gap="2" className={styles.toolbarGroup}>
            <ComposerAttachment
              label={content.composer.attachLabel}
              allowedKinds={ATTACHABLE_MEDIA_KINDS}
              value={attachment}
              onChange={setAttachment}
              isDisabled={!isWindowOpen}
              variant="inline"
            />
            {templateAction}
          </Cluster>

          <div className={styles.toolbarHint}>{windowHint}</div>

          <Cluster gap="2" justify="end" className={styles.toolbarActions}>
            <button
              type="button"
              className={styles.expand}
              aria-expanded={isExpanded}
              aria-label={isExpanded ? content.composer.collapse : content.composer.expand}
              onClick={() => {
                setIsExpanded((current) => !current);
              }}
            >
              <Icon name={isExpanded ? 'collapse' : 'expand'} size="sm" />
            </button>
            <Button
              type="submit"
              variant="primary"
              disabled={!isWindowOpen || attachment.status === 'uploading'}
              isPending={isPending}
            >
              {content.composer.send}
            </Button>
          </Cluster>
        </div>
      </Stack>
    </form>
  );
}

/**
 * Mirrors `FreeFormComposer`: a textarea of the same row count, and the toolbar's
 * two groups at the same height — so the swap moves nothing under the cursor of
 * an agent already reaching for the box.
 */
export function FreeFormComposerSkeleton() {
  return (
    <Stack gap="2" aria-hidden="true">
      <SkeletonBlock height={`calc(${String(TEXTAREA_ROWS)}lh + var(--space-2) * 2)`} />

      <div className={styles.toolbar}>
        <Cluster gap="2" className={styles.toolbarGroup}>
          <ComposerAttachmentSkeleton variant="inline" />
          <SkeletonLine width="8.5rem" height="var(--size-control-md)" />
        </Cluster>
        <div className={styles.toolbarHint}>
          <SkeletonLine width="10rem" />
        </div>
        <Cluster gap="2" justify="end" className={styles.toolbarActions}>
          <SkeletonLine width="5rem" height="var(--size-touch-target)" />
        </Cluster>
      </div>
    </Stack>
  );
}

/** Two lines of reply before it grows — the floor its skeleton reserves. */
const TEXTAREA_ROWS = 2;
