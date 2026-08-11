'use client';

import { useCallback, useRef, useState, type FormEvent } from 'react';
import type { SendMediaInput, SendTextInput } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import { Textarea } from '@/components/ui/Textarea';
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

/**
 * The free-form half of the composer: a message the agent writes themselves,
 * optionally carrying one file. Usage:
 * `<FreeFormComposer conversationId={id} isWindowOpen={…} />`.
 *
 * A real `<form>` with a real submit, like the note form beside it. The draft is
 * cleared only on success — a failed send must never make somebody retype a
 * reply — and the field is refocused afterwards, because an agent who sent one
 * message usually sends another.
 *
 * ## Disabled, not hidden, outside the window
 *
 * When the service window shuts the controls go inert and the draft stays put.
 * Removing the box would throw away what was typed and leave the agent guessing
 * why; the banner above says what happened, and the template picker below is the
 * way through.
 *
 * ## One file, and it is already uploaded
 *
 * WhatsApp carries one media object per message, so this holds one. What that
 * does to the send — a media type, a shorter ceiling, the text becoming a
 * caption — is `buildFreeFormSend`'s to decide, not this form's.
 */
export function FreeFormComposer({
  conversationId,
  isWindowOpen,
}: {
  conversationId: string;
  isWindowOpen: boolean;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const { keyFor, retire } = useIdempotencyKey();
  const [body, setBody] = useState('');
  const [attachment, setAttachment] = useState<ComposerAttachmentValue>(EMPTY_ATTACHMENT);
  const [problem, setProblem] = useState<FreeFormProblem | null>(null);
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
      <Stack gap="3">
        <Field
          label={content.composer.replyLabel}
          hint={content.composer.replyHint}
          error={problem === null ? undefined : problemMessages[problem]}
          isRequired={attachment.status !== 'ready'}
        >
          {({ controlId, describedBy, isInvalid }) => (
            <Textarea
              id={controlId}
              ref={textareaRef}
              name="body"
              value={body}
              rows={TEXTAREA_ROWS}
              maxLength={maxLength}
              disabled={!isWindowOpen}
              placeholder={content.composer.replyPlaceholder}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              onChange={(event) => {
                setBody(event.target.value);
              }}
            />
          )}
        </Field>

        <ComposerAttachment
          label={content.composer.attachLabel}
          allowedKinds={ATTACHABLE_MEDIA_KINDS}
          value={attachment}
          onChange={setAttachment}
          isDisabled={!isWindowOpen}
        />

        <FormError message={formError} requestId={requestId} />

        <Cluster justify="end" gap="2">
          <Button
            type="submit"
            variant="primary"
            disabled={!isWindowOpen || attachment.status === 'uploading'}
            isPending={isPending}
          >
            {content.composer.send}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

/**
 * Mirrors `FreeFormComposer`: label, hint, a textarea of the same row count, the
 * attach control's own skeleton, and the Send button's place in the row.
 */
export function FreeFormComposerSkeleton() {
  return (
    <Stack gap="3" aria-hidden="true">
      <Stack gap="1">
        <SkeletonLine width="10rem" />
        <SkeletonLine width="14rem" />
        <SkeletonBlock height={`calc(var(--size-control-md) * ${String(TEXTAREA_ROWS)} / 2)`} />
      </Stack>

      <ComposerAttachmentSkeleton />

      <Cluster justify="end">
        <SkeletonLine width="5rem" height="var(--size-touch-target)" />
      </Cluster>
    </Stack>
  );
}

/** Three lines of reply before it scrolls — and the height its skeleton reserves. */
const TEXTAREA_ROWS = 3;
