'use client';

import type { Tag, TagCondition } from '@whatsappcrm/contracts';
import { CheckboxGroup, type CheckboxOption } from '@/components/ui/CheckboxGroup';
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
 *
 * A tag the rule references that no longer exists still gets a row, checked, so it
 * can be unchecked. Rendering only the tags that resolve would leave the dead id
 * in the condition invisibly and send it back on every save — the API refuses it,
 * and the supervisor would be told "that tag is not in this workspace" beside a
 * picker with nothing wrong in it, with no way out but deleting the condition.
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
        options={tagOptions(tags, condition.tagIds, copy.summaryUnknownReference)}
        selectedValues={condition.tagIds}
        onChange={(tagIds) => {
          onChange({ ...condition, tagIds: [...tagIds] });
        }}
      />
    </>
  );
}

/**
 * The workspace's tags, plus a row for any id the condition holds that no longer
 * resolves — checked, and labelled the same way the rule summary labels it, so the
 * supervisor sees the same thing in both places and can uncheck it.
 */
function tagOptions(
  tags: readonly Tag[],
  selectedTagIds: readonly string[],
  unknownLabel: string,
): readonly CheckboxOption[] {
  const known = new Set(tags.map((tag) => tag.id));

  return [
    ...tags.map((tag) => ({ value: tag.id, label: tag.name })),
    ...selectedTagIds
      .filter((tagId) => !known.has(tagId))
      .map((tagId) => ({ value: tagId, label: unknownLabel })),
  ];
}
