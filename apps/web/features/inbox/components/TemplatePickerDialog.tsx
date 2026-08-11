'use client';

import { useState } from 'react';
import type { MessageTemplateResponse } from '@whatsappcrm/contracts';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { TextInput } from '@/components/ui/TextInput';
import { Stack } from '@/components/layout/Stack';
import { useToast } from '@/components/ui/ToastProvider';
import { useContent } from '@/lib/content';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { useTemplateSearch, type TemplateSearchState } from '@/features/inbox/useTemplateSearch';
import { TemplateList, TemplateListSkeleton } from './TemplateList';
import { TemplateSendForm } from './TemplateSendForm';

/**
 * Choose an approved template, fill it in, send it. Usage — through
 * `LazyTemplatePickerDialog`, so the chunk arrives on the first open:
 * `<TemplatePickerDialog conversationId={id} onClose={…} />`.
 *
 * Two steps in one dialog rather than two dialogs: picking and filling are one
 * decision, and an agent who reads the variables and changes their mind goes
 * back rather than starting again. The search is debounced, because `q` is a
 * name prefix served by an index and not something to hit per keystroke.
 *
 * The list is loaded when the dialog opens, never with the page. Most replies
 * are free-form, and a tenant's whole approved template set has no business in
 * the inbox's initial payload.
 */

export interface TemplatePickerDialogProps {
  conversationId: string;
  onClose: () => void;
}

export function TemplatePickerDialog({ conversationId, onClose }: TemplatePickerDialogProps) {
  const content = useContent();
  const { showToast } = useToast();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<MessageTemplateResponse | null>(null);
  const { state, retry } = useTemplateSearch(
    conversationId,
    useDebouncedValue(query, SEARCH_DEBOUNCE_MS),
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={content.composer.templateTitle}
      description={content.composer.templateDescription}
    >
      {chosen === null ? (
        <Stack gap="4">
          <Field label={content.composer.templateSearchLabel}>
            {({ controlId, describedBy, isInvalid }) => (
              <TextInput
                id={controlId}
                type="search"
                value={query}
                placeholder={content.composer.templateSearchPlaceholder}
                aria-describedby={describedBy}
                aria-invalid={isInvalid}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            )}
          </Field>

          <TemplateResults
            state={state}
            hasQuery={query.trim() !== ''}
            onRetry={retry}
            onChoose={setChosen}
          />
        </Stack>
      ) : (
        <TemplateSendForm
          conversationId={conversationId}
          template={chosen}
          onSent={() => {
            showToast({
              tone: 'success',
              message: content.composer.templateSendSuccess(chosen.name),
            });
            onClose();
          }}
          onBack={() => {
            setChosen(null);
          }}
        />
      )}
    </Modal>
  );
}

/** Loading, failed, empty and ready — each in the box the list will occupy. */
function TemplateResults({
  state,
  hasQuery,
  onRetry,
  onChoose,
}: {
  state: TemplateSearchState;
  hasQuery: boolean;
  onRetry: () => void;
  onChoose: (template: MessageTemplateResponse) => void;
}) {
  const content = useContent();

  if (state.status === 'loading') {
    return <TemplateListSkeleton />;
  }

  if (state.status === 'failed') {
    return <ErrorState onRetry={onRetry} body={state.message} requestId={state.requestId} />;
  }

  if (state.templates.length === 0) {
    // Two different situations, and telling them apart is the whole value of the
    // empty state: "you have no templates, ask an admin to submit some" and
    // "that search matched none of the ones you have" need different next steps.
    return hasQuery ? (
      <EmptyState
        heading={content.composer.templateNoMatchHeading}
        body={content.composer.templateNoMatchBody}
      />
    ) : (
      <EmptyState
        heading={content.composer.templateEmptyHeading}
        body={content.composer.templateEmptyBody}
      />
    );
  }

  return (
    <Stack gap="3">
      {state.hasMore ? <Notice tone="info">{content.composer.templateMoreNotice}</Notice> : null}
      <TemplateList templates={state.templates} onChoose={onChoose} />
    </Stack>
  );
}

const SEARCH_DEBOUNCE_MS = 300;
