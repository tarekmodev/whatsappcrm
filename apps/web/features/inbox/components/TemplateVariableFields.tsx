'use client';

import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { Stack } from '@/components/layout/Stack';

/**
 * One text field per positional placeholder in an approved template. Usage:
 *
 * ```tsx
 * <TemplateVariableFields
 *   values={draft.variables}
 *   label={content.composer.templateVariableLabel}
 *   onChange={setVariables}
 * />
 * ```
 *
 * Used twice — for the BODY's `{{n}}` and for a `text` header's, which are
 * supplied through different slots of the send but are the same control. The
 * label is a prop rather than a branch, so the two read differently on screen
 * without this file knowing which it is rendering.
 *
 * Positional, so a value is replaced by index and the array keeps its length:
 * the send path checks arity against what Meta approved, and a shorter array is
 * a refusal rather than a blank in the message.
 */

export interface TemplateVariableFieldsProps {
  values: readonly string[];
  /** Phrases the 1-based position; from the content layer, never built here. */
  label: (position: number) => string;
  onChange: (values: readonly string[]) => void;
  isDisabled?: boolean;
}

export function TemplateVariableFields({
  values,
  label,
  onChange,
  isDisabled = false,
}: TemplateVariableFieldsProps) {
  if (values.length === 0) {
    return null;
  }

  return (
    <Stack gap="3">
      {values.map((value, index) => (
        // The index *is* the identity: these are `{{1}}`, `{{2}}`, `{{3}}`, and
        // the list neither reorders nor changes length while it is on screen.
        <Field key={index} label={label(index + 1)} isRequired>
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              value={value}
              disabled={isDisabled}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              onChange={(event) => {
                onChange(
                  values.map((current, at) => (at === index ? event.target.value : current)),
                );
              }}
            />
          )}
        </Field>
      ))}
    </Stack>
  );
}
