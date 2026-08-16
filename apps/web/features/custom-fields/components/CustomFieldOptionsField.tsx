'use client';

import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { useContent } from '@/lib/content';

/**
 * The option list for a `select` definition, one per line. Usage:
 * `<CustomFieldOptionsField value={optionsText} onChange={…} error={…} />`.
 *
 * Shared by the create and edit dialogs, which is the point: options are the one
 * thing both may write, and two textareas with two different hints would drift.
 *
 * A textarea rather than a repeating row of inputs with add/remove buttons. The
 * list is short, ordered, and most often pasted in from somewhere else; a
 * line-per-option is the fastest way to type it and the only one that survives a
 * paste. `parseOptionsText` owns the trimming and the blank-line dropping.
 */
export function CustomFieldOptionsField({
  value,
  onChange,
  error,
  isDisabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  isDisabled?: boolean;
}) {
  const content = useContent();

  return (
    <Field
      label={content.customFields.optionsLabel}
      hint={content.customFields.optionsHint}
      error={error}
      isRequired
    >
      {({ controlId, describedBy, isInvalid }) => (
        <Textarea
          id={controlId}
          aria-describedby={describedBy}
          aria-invalid={isInvalid}
          name="options"
          rows={OPTION_ROWS}
          disabled={isDisabled}
          placeholder={content.customFields.optionsPlaceholder}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}

/**
 * Four lines: enough to see a typical option set without scrolling, and short
 * enough that the dialog still fits a phone in landscape. The cap the API
 * enforces is `CUSTOM_FIELD_LIMITS.optionsPerDefinition`, which is validated
 * rather than made unreachable by the box's height.
 */
const OPTION_ROWS = 4;
