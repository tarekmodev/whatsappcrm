'use client';

import { useCallback, useState } from 'react';
import { KNOWLEDGE_DOCUMENT_LIMITS, type KnowledgeDocumentResponse } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Textarea } from '@/components/ui/Textarea';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { createKnowledgeEntryAction, updateKnowledgeEntryAction } from '../chatbot.actions';
import { validateEntry, type EntryErrors } from '../entry-form';

/**
 * Writes one knowledge base entry. Usage:
 * `<KnowledgeEntryDialog onClose={…} />` to add, or with `document` to edit.
 *
 * One dialog for both, not two: the fields, the validation and the body are
 * identical, and the only differences are the title, the submit label and which
 * action runs. Two components that differ by a string are one component with a
 * prop.
 *
 * **The description tells an author to separate topics with a blank line**,
 * because that is literally how the indexer splits: paragraph-packed chunks on
 * blank-line boundaries. An entry written as one wall of text becomes one chunk
 * that either matches a question or does not, and nothing else in the product
 * will ever explain that to the person writing it.
 */
export function KnowledgeEntryDialog({
  document,
  onClose,
}: {
  /** Omitted to add a new entry; present to edit that one. */
  document?: KnowledgeDocumentResponse;
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const [title, setTitle] = useState(document?.title ?? '');
  const [body, setBody] = useState(document?.content ?? '');
  const [sourceUrl, setSourceUrl] = useState(document?.sourceUrl ?? '');
  const [fieldErrors, setFieldErrors] = useState<EntryErrors>({});
  const isEditing = document !== undefined;

  const perform = useCallback(async () => {
    const input = {
      title: title.trim(),
      content: body.trim(),
      // Absent, not `null`: both inputs make every field optional, and an
      // omitted key leaves the stored value alone rather than clearing it.
      ...(sourceUrl.trim() === '' ? {} : { sourceUrl: sourceUrl.trim() }),
    };

    return document === undefined
      ? createKnowledgeEntryAction(input)
      : updateKnowledgeEntryAction(document.id, input);
  }, [body, document, sourceUrl, title]);

  const onSuccess = useCallback(
    ({ title: savedTitle }: { title: string }) => {
      showToast({
        tone: 'success',
        message: isEditing
          ? content.chatbot.editSuccess(savedTitle)
          : content.chatbot.createSuccess(savedTitle),
      });
      onClose();
    },
    [content, isEditing, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={isEditing ? content.chatbot.editTitle : content.chatbot.createTitle}
      description={isEditing ? content.chatbot.editDescription : content.chatbot.createDescription}
      submitLabel={isEditing ? content.chatbot.editSubmit : content.chatbot.createSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        const errors = validateEntry({ title, body, sourceUrl });

        setFieldErrors(errors);

        if (Object.keys(errors).length === 0) {
          submit();
        }
      }}
    >
      <Field label={content.chatbot.entryTitleLabel} error={fieldErrors.title} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="title"
            autoComplete="off"
            maxLength={KNOWLEDGE_DOCUMENT_LIMITS.titleMaxLength}
            placeholder={content.chatbot.entryTitlePlaceholder}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setFieldErrors({});
            }}
          />
        )}
      </Field>

      <Field label={content.chatbot.entryContentLabel} error={fieldErrors.content} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <Textarea
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="content"
            // Ten rows, so the blank lines that become chunk boundaries are
            // visible while the entry is being written rather than after it is
            // saved.
            rows={10}
            placeholder={content.chatbot.entryContentPlaceholder}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              setFieldErrors({});
            }}
          />
        )}
      </Field>

      <Field
        label={content.chatbot.entrySourceUrlLabel}
        hint={content.chatbot.entrySourceUrlHint}
        error={fieldErrors.sourceUrl}
      >
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="sourceUrl"
            type="url"
            inputMode="url"
            autoComplete="off"
            maxLength={KNOWLEDGE_DOCUMENT_LIMITS.sourceUrlMaxLength}
            value={sourceUrl}
            onChange={(event) => {
              setSourceUrl(event.target.value);
              setFieldErrors({});
            }}
          />
        )}
      </Field>
    </FormDialog>
  );
}
