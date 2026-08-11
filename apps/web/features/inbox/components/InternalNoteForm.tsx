'use client';

import { useCallback, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import { Textarea } from '@/components/ui/Textarea';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { addInternalNoteAction } from '@/features/inbox/inbox.actions';
import { NOTE_BODY_MAX_LENGTH } from '@/features/inbox/constants';
import styles from './InternalNotesPanel.module.css';

/**
 * Writes an internal note. Usage: `<InternalNoteForm conversationId={id} />`.
 *
 * A real `<form>` with a real submit, so Enter works and the browser's own
 * validation semantics apply. The body is checked against the *contract's* own
 * schema before it is sent, so a note that is too long is refused where the
 * agent can still edit it rather than after a round trip.
 *
 * The field is cleared only on success. A failed submit keeps what was typed —
 * nobody should have to write a note twice.
 */

export function InternalNoteForm({ conversationId }: { conversationId: string }) {
  const content = useContent();
  const { showToast } = useToast();
  const [body, setBody] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const onSuccess = useCallback(() => {
    setBody('');
    showToast({ tone: 'success', message: content.notes.addSuccess });
    // Back to the field: an agent adding one note usually adds another, and a
    // submit that leaves focus on a disabled button strands a keyboard user.
    textareaRef.current?.focus();
  }, [content.notes.addSuccess, showToast]);

  const { submit, isPending, formError, requestId } = useActionForm({
    perform: () => addInternalNoteAction(conversationId, { body: body.trim() }),
    onSuccess,
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const trimmed = body.trim();

    if (trimmed === '') {
      setFieldError(content.notes.bodyRequiredError);
      textareaRef.current?.focus();
      return;
    }

    if (trimmed.length > NOTE_BODY_MAX_LENGTH) {
      setFieldError(content.notes.bodyTooLongError(NOTE_BODY_MAX_LENGTH));
      textareaRef.current?.focus();
      return;
    }

    setFieldError(null);
    submit();
  };

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <Stack gap="3">
        <Field
          label={content.notes.addLabel}
          hint={content.notes.privacyNotice}
          error={fieldError ?? undefined}
          isRequired
        >
          {({ controlId, describedBy, isInvalid }) => (
            <Textarea
              id={controlId}
              ref={textareaRef}
              name="body"
              value={body}
              maxLength={NOTE_BODY_MAX_LENGTH}
              placeholder={content.notes.addPlaceholder}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              onChange={(event) => {
                setBody(event.target.value);
              }}
            />
          )}
        </Field>

        <FormError message={formError} requestId={requestId} />

        <Cluster justify="end" gap="2">
          <Button type="submit" variant="primary" isPending={isPending}>
            {content.notes.addSubmit}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
