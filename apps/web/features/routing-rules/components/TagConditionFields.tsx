'use client';

import type { Tag, TagCondition } from '@whatsappcrm/contracts';
import { CheckboxGroup } from '@/components/ui/CheckboxGroup';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';

/**
 * "The contact is tagged VIP." Usage: rendered by `ConditionFields` for a `tag`
 * condition.
 *
 * Checkboxes over a multi-select for the reason `TeamSelectionField` uses them: a
 * workspace's tag set is short and known, and a list of checkboxes is keyboard-
 * and screen-reader-correct with no JavaScript.
 */
export function TagConditionFields({
  condition,
  tags,
  error,
  onChange,
}: {
  condition: TagCondition;
  tags: readonly Tag[];
  error?: string;
  onChange: (condition: TagCondition) => void;
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

      <CheckboxGroup
        legend={copy.tagsLabel}
        error={error}
        emptyLabel={copy.tagsUnavailable}
        options={tags.map((tag) => ({ value: tag.id, label: tag.name }))}
        selectedValues={condition.tagIds}
        onChange={(tagIds) => {
          onChange({ ...condition, tagIds: [...tagIds] });
        }}
      />
    </>
  );
}
