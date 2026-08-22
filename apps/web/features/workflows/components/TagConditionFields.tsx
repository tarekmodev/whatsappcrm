'use client';

import type {
  WorkflowCatalogResponse,
  WorkflowCondition,
  WorkflowMatchOperator,
} from '@whatsappcrm/contracts';
import { CheckboxGroup } from '@/components/ui/CheckboxGroup';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { conditionOperatorValues, labelledOptions, tagOptions } from '../builder';
import type { WorkflowVocabulary } from '../presentation';

/** The two conditions built out of "a match mode and a set of tag ids". */
type TagCondition = Extract<WorkflowCondition, { type: 'ticket_tag' | 'contact_tag' }>;

/**
 * "The ticket is tagged escalated." Usage: rendered by `ConditionFields` for a
 * `ticket_tag` or `contact_tag` condition.
 *
 * One component for both: a ticket tag and a contact tag read from different
 * tables but pick from the same taxonomy and offer the same three match modes.
 * `none` exists here and does not in the routing-rule grammar — a workflow list
 * has no first-match ordering to express a negation with, so the negation has to
 * be in the grammar (ADR 0009).
 *
 * A tag the workflow references that no longer exists still gets a row, checked,
 * so it can be unchecked. Rendering only the tags that resolve would leave the
 * dead id in the condition invisibly and send it back on every save.
 */
export function TagConditionFields({
  condition,
  catalog,
  vocabulary,
  error,
  onChange,
}: {
  condition: TagCondition;
  catalog: WorkflowCatalogResponse;
  vocabulary: WorkflowVocabulary;
  error?: string;
  onChange: (condition: WorkflowCondition) => void;
}) {
  const content = useContent();
  const copy = content.workflows;

  return (
    <>
      <Field label={copy.matchLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={condition.match}
            options={labelledOptions(
              conditionOperatorValues(catalog, condition.type),
              copy.matchOperators,
            )}
            onChange={(event) => {
              onChange({ ...condition, match: event.target.value as WorkflowMatchOperator });
            }}
          />
        )}
      </Field>

      <CheckboxGroup
        legend={copy.tagsLabel}
        error={error}
        emptyLabel={copy.tagsUnavailable}
        options={tagOptions(vocabulary, condition.tagIds, copy.unknownReference)}
        selectedValues={condition.tagIds}
        onChange={(tagIds) => {
          onChange({ ...condition, tagIds: [...tagIds] });
        }}
      />
    </>
  );
}
