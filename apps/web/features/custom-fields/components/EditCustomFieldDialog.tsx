'use client';

import { useCallback, useState } from 'react';
import { CUSTOM_FIELD_LIMITS, type CustomFieldDefinition } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { StaticFieldValue } from '@/components/ui/StaticFieldValue';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { updateCustomFieldAction } from '../custom-fields.actions';
import {
  clearIssue,
  definitionIssues,
  hasIssues,
  optionsToText,
  parseOptionsText,
  type DefinitionIssues,
} from '../definition-form';
import { CustomFieldOptionsField } from './CustomFieldOptionsField';

/**
 * Renames a custom field and edits a `select`'s options. Usage:
 * `<EditCustomFieldDialog definition={definition} onClose={…} />`.
 *
 * **`key` and `type` are shown, not offered.** They are immutable after creation
 * (0002 amendment 10): the key is what a routing condition names and what every
 * stored value is filed under, and the type is what every stored value was
 * validated against. Both are delete-and-recreate, and the API refuses a body
 * carrying either — so they are `StaticFieldValue`s with a line saying why,
 * rather than disabled inputs that imply "not right now".
 *
 * Only what changed is sent, because `CustomFieldDefinitionUpdateInputSchema`
 * requires at least one field and a blanket write would clobber a concurrent
 * edit to the half this dialog did not touch.
 */
export function EditCustomFieldDialog({
  definition,
  onClose,
}: {
  definition: CustomFieldDefinition;
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();

  const [label, setLabel] = useState(definition.label);
  const [optionsText, setOptionsText] = useState(optionsToText(definition.options));
  const [issues, setIssues] = useState<DefinitionIssues>({});

  const draft = { label, key: definition.key, type: definition.type, optionsText };

  const perform = useCallback(async () => {
    return updateCustomFieldAction(definition.id, changedFields(definition, label, optionsText));
  }, [definition, label, optionsText]);

  const onSuccess = useCallback(
    ({ label: savedLabel }: { label: string }) => {
      showToast({ tone: 'success', message: content.customFields.editSuccess(savedLabel) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  const hasChanges = Object.keys(changedFields(definition, label, optionsText)).length > 0;

  return (
    <FormDialog
      isOpen
      title={content.customFields.editTitle(definition.label)}
      submitLabel={content.common.save}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      isSubmitDisabled={!hasChanges}
      onClose={onClose}
      onSubmit={() => {
        const found = definitionIssues(draft, { isKeyEditable: false });

        setIssues(found);

        if (!hasIssues(found)) {
          submit();
        }
      }}
    >
      <Field
        label={content.customFields.labelLabel}
        hint={content.customFields.labelHint}
        error={issues.label}
        isRequired
      >
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="label"
            autoComplete="off"
            maxLength={CUSTOM_FIELD_LIMITS.labelLength}
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
              setIssues((current) => clearIssue(current, 'label'));
            }}
          />
        )}
      </Field>

      <Field label={content.customFields.keyLabel} hint={content.customFields.keyImmutableHint}>
        {({ controlId }) => <StaticFieldValue id={controlId}>{definition.key}</StaticFieldValue>}
      </Field>

      <Field label={content.customFields.typeLabel} hint={content.customFields.typeImmutableHint}>
        {({ controlId }) => (
          <StaticFieldValue id={controlId}>
            {content.customFieldTypes[definition.type]}
          </StaticFieldValue>
        )}
      </Field>

      {definition.type === 'select' ? (
        <CustomFieldOptionsField
          value={optionsText}
          error={issues.options}
          isDisabled={isPending}
          onChange={(value) => {
            setOptionsText(value);
            setIssues((current) => clearIssue(current, 'options'));
          }}
        />
      ) : null}
    </FormDialog>
  );
}

/**
 * Only what changed. `CustomFieldDefinitionUpdateInputSchema` refuses an empty
 * body, and sending `options` back untouched would overwrite an option a
 * colleague added while this dialog was open.
 */
function changedFields(
  definition: CustomFieldDefinition,
  label: string,
  optionsText: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const trimmedLabel = label.trim();

  if (trimmedLabel !== definition.label) {
    patch.label = trimmedLabel;
  }

  if (definition.type === 'select') {
    const options = parseOptionsText(optionsText);

    // Order is meaningful for a `select` — it is the order the picker offers —
    // so this is a positional comparison, not a set one.
    if (options.join('\n') !== definition.options.join('\n')) {
      patch.options = options;
    }
  }

  return patch;
}
