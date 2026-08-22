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
import { ENTRY_CONTENT_ROWS } from '../constants';
import { validateEntry, type EntryErrors } from '../entry-form';

/**
 * Writes one knowledge base entry. Usage:
 * `<KnowledgeEntryForm onClose={…} />` to add, or with `entry` to edit that one.
 *
 * One form for both, not two: the fields, the validation and the body are
 * identical, and the only differences are the title, the submit label and which
 * action runs. Two components that differ by a string are one component with a
 * prop.
 *
 * `entry` is the **full** entry, never a list row: the list omits `content`, and
 * a form prefilled from one would save that absence back over the text. Fetching
 * it is `KnowledgeEntryDialog`'s job, so this component only ever renders with
 * something real to edit.
 *
 * **The description tells an author to separate topics with a blank line**,
 * because that is literally how the indexer splits: paragraph-packed chunks on
 * blank-line boundaries. An entry written as one wall of text becomes one chunk
 * that either matches a question or does not, and nothing else in the product
 * will ever explain that to the person writing it.
 */
export function KnowledgeEntryForm({
  entry,
  onClose,
}: {
  /** Omitted to add a new entry; present to edit that one. */
  entry?: KnowledgeDocumentResponse;
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const [title, setTitle] = useState(entry?.title ?? '');
  const [body, setBody] = useState(entry?.content ?? '');
  const [sourceUrl, setSourceUrl] = useState(entry?.sourceUrl ?? '');
  const [fieldErrors, setFieldErrors] = useState<EntryErrors>({});
  const isEditing = entry !== undefined;

  const perform = useCallback(async () => {
    const fields = { title: title.trim(), content: body.trim() };
    const trimmedSourceUrl = sourceUrl.trim();

    if (entry === undefined) {
      // Absent rather than `null`: on a document that does not exist yet,
      // "clear it" and "do not set it" are the same instruction.
      return createKnowledgeEntryAction({
        ...fields,
        ...(trimmedSourceUrl === '' ? {} : { sourceUrl: trimmedSourceUrl }),
      });
    }

    // `null` rather than absent, and this is the whole reason the update
    // contract is nullable: an omitted key leaves the stored URL alone, so
    // emptying the field used to report "Saved" and change nothing.
    return updateKnowledgeEntryAction(entry.id, {
      ...fields,
      sourceUrl: trimmedSourceUrl === '' ? null : trimmedSourceUrl,
    });
  }, [body, entry, sourceUrl, title]);

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
            maxLength={KNOWLEDGE_DOCUMENT_LIMITS.titleLength}
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
            // saved. Shared with the skeleton so the two cannot drift.
            rows={ENTRY_CONTENT_ROWS}
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
            maxLength={KNOWLEDGE_DOCUMENT_LIMITS.sourceUrlLength}
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
