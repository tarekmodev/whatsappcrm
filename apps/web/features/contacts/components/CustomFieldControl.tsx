'use client';

import { CUSTOM_FIELD_LIMITS, type CustomFieldDefinition } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/TextInput';
import { useContent } from '@/lib/content';
import {
  booleanSelectOptions,
  customFieldSelectOptions,
  isStaleSelectValue,
} from '../presentation';

/**
 * One custom field, as the control its type calls for. Usage:
 * `<CustomFieldControl definition={definition} value={value} onChange={…} />`.
 *
 * The single place a `CustomFieldType` becomes a control, so the profile form and
 * anything that renders one later cannot disagree about what a `date` looks like.
 * Every branch goes through `Field`, which is what guarantees the label,
 * `aria-describedby` and `aria-invalid` are wired.
 *
 * A value always crosses the wire as a **string**, whatever the type — `'true'`,
 * `'2026-08-16'`, `'42'` — so every control here is a string control and the
 * conversion the contract would otherwise need does not exist.
 */

export interface CustomFieldControlProps {
  definition: CustomFieldDefinition;
  /** `''` is "not set"; a native control's value is never `null`. */
  value: string;
  onChange: (value: string) => void;
  error?: string;
  isDisabled?: boolean;
}

export function CustomFieldControl({
  definition,
  value,
  onChange,
  error,
  isDisabled = false,
}: CustomFieldControlProps) {
  const content = useContent();
  const hint = isStaleSelectValue(definition, value) ? content.contacts.staleOptionHint : undefined;

  return (
    <Field label={definition.label} hint={hint} error={error}>
      {({ controlId, describedBy, isInvalid }) => {
        const shared = {
          id: controlId,
          'aria-describedby': describedBy,
          'aria-invalid': isInvalid,
          name: definition.key,
          disabled: isDisabled,
          onChange: (event: { target: { value: string } }) => {
            onChange(event.target.value);
          },
        };

        switch (definition.type) {
          case 'select':
            return (
              <Select
                {...shared}
                value={value}
                options={customFieldSelectOptions(definition, value)}
              />
            );
          case 'boolean':
            return <Select {...shared} value={value} options={booleanSelectOptions()} />;
          case 'date':
            // The native date control. Its value is already `YYYY-MM-DD`, which
            // is exactly what `CUSTOM_FIELD_DATE_PATTERN` wants, and it accepts
            // typed input as well as the picker.
            return <TextInput {...shared} type="date" value={value} />;
          case 'number':
            // `type="text"` with a numeric keypad, deliberately not
            // `type="number"`: a browser reports an unparseable entry in a
            // number input as the empty string, which this form would read as
            // "clear this field" and silently save. Validation is
            // `customFieldValueIssue`'s, and it can only run on what the user
            // actually typed.
            return <TextInput {...shared} type="text" inputMode="decimal" value={value} />;
          case 'text':
            return (
              <TextInput
                {...shared}
                type="text"
                value={value}
                maxLength={CUSTOM_FIELD_LIMITS.textValueLength}
              />
            );
        }
      }}
    </Field>
  );
}
