'use client';

import type { KeywordCondition } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useContent } from '@/lib/content';

/**
 * "The message mentions billing, invoice or refund." Usage: rendered by
 * `ConditionFields` for a `keyword` condition.
 *
 * One phrase per line rather than a comma-separated box, because a supervisor
 * routing on "past due" should not have to think about whether the comma is part
 * of the phrase. Blank lines are dropped at validation, so a trailing newline is
 * not an error.
 */
export function KeywordConditionFields({
  condition,
  error,
  onChange,
}: {
  condition: KeywordCondition;
  error?: string;
  onChange: (condition: KeywordCondition) => void;
}) {
  const content = useContent();
  const copy = content.routingRules;

  return (
    <>
      <Field label={copy.matchLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={condition.match}
            options={[
              { value: 'any', label: copy.matchAny },
              { value: 'all', label: copy.matchAll },
            ]}
            onChange={(event) => {
              onChange({ ...condition, match: event.target.value === 'all' ? 'all' : 'any' });
            }}
          />
        )}
      </Field>

      <Field label={copy.keywordValuesLabel} hint={copy.keywordValuesHint} error={error} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <Textarea
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            rows={LINES_VISIBLE}
            value={condition.values.join('\n')}
            onChange={(event) => {
              // Split, never trimmed here: trimming as the user types would eat
              // the space they are in the middle of. `validateRuleDraft` cleans it.
              onChange({ ...condition, values: event.target.value.split('\n') });
            }}
          />
        )}
      </Field>
    </>
  );
}

/**
 * Tall enough to show a typical rule whole — three or four phrases — without
 * making the dialog scroll on a phone. The control still resizes.
 */
const LINES_VISIBLE = 4;
