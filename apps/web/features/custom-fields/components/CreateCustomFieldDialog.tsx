'use client';

import { useCallback, useState } from 'react';
import { CUSTOM_FIELD_LIMITS, type CustomFieldType } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { createCustomFieldAction } from '../custom-fields.actions';
import {
  clearIssue,
  definitionIssues,
  hasIssues,
  parseOptionsText,
  suggestKeyFromLabel,
  type DefinitionIssues,
} from '../definition-form';
import { customFieldTypeOptions, parseCustomFieldType } from '../presentation';
import { CustomFieldOptionsField } from './CustomFieldOptionsField';

/**
 * Defines a new custom field. Usage:
 * `<CreateCustomFieldDialog onClose={…} />`.
 *
 * This is TAR-33's fourth acceptance criterion: an admin names a field, picks a
 * type, and gives a `select` its options — after which every contact profile in
 * the tenant carries it.
 *
 * The key is **suggested** from the label and stays editable until the admin
 * touches it, at which point it stops following. It is immutable after creation
 * and it is what a routing rule names, so getting it right here matters more
 * than saving a keystroke — but making an admin invent `plan_tier` from "Plan
 * tier" by hand is how you get `planTier` and `plan-tier` in the same workspace.
 */
export function CreateCustomFieldDialog({ onClose }: { onClose: () => void }) {
  const content = useContent();
  const { showToast } = useToast();

  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [isKeyEdited, setIsKeyEdited] = useState(false);
  const [type, setType] = useState<CustomFieldType>('text');
  const [optionsText, setOptionsText] = useState('');
  const [issues, setIssues] = useState<DefinitionIssues>({});

  const draft = { label, key, type, optionsText };

  const perform = useCallback(async () => {
    return createCustomFieldAction({
      label: label.trim(),
      key: key.trim(),
      type,
      // Forbidden for every type but `select`, in both directions — the
      // contract's own `optionsMatchType` refine.
      options: type === 'select' ? parseOptionsText(optionsText) : [],
    });
  }, [key, label, optionsText, type]);

  const onSuccess = useCallback(
    ({ label: savedLabel }: { label: string }) => {
      showToast({ tone: 'success', message: content.customFields.createSuccess(savedLabel) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.customFields.createTitle}
      description={content.customFields.createDescription}
      submitLabel={content.customFields.createSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        const found = definitionIssues(draft, { isKeyEditable: true });

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
            placeholder={content.customFields.labelPlaceholder}
            value={label}
            onChange={(event) => {
              const nextLabel = event.target.value;

              setLabel(nextLabel);
              setIssues((current) => clearIssue(current, 'label'));

              // Stops following the moment the admin edits the key themselves,
              // so a deliberate key is never overwritten by the next keystroke
              // in the label.
              if (!isKeyEdited) {
                setKey(suggestKeyFromLabel(nextLabel));
              }
            }}
          />
        )}
      </Field>

      <Field
        label={content.customFields.keyLabel}
        hint={content.customFields.keyHint}
        error={issues.key}
        isRequired
      >
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="key"
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            maxLength={CUSTOM_FIELD_LIMITS.keyLength}
            placeholder={content.customFields.keyPlaceholder}
            value={key}
            onChange={(event) => {
              setIsKeyEdited(true);
              setKey(event.target.value);
              setIssues((current) => clearIssue(current, 'key'));
            }}
          />
        )}
      </Field>

      <Field label={content.customFields.typeLabel} hint={content.customFields.typeHint}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            name="type"
            value={type}
            options={customFieldTypeOptions()}
            onChange={(event) => {
              setType(parseCustomFieldType(event.target.value));
              setIssues((current) => clearIssue(current, 'options'));
            }}
          />
        )}
      </Field>

      {/* Only `select` takes options, so only `select` is offered a box for
          them — the contract refuses them on every other type. */}
      {type === 'select' ? (
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
