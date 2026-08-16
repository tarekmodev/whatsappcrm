'use client';

import type { WorkflowCatalogResponse, WorkflowCondition } from '@whatsappcrm/contracts';
import { CheckboxGroup } from '@/components/ui/CheckboxGroup';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import {
  conditionOperatorValues,
  conditionValues,
  labelledCheckboxOptions,
  labelledOptions,
} from '../builder';

/** The two conditions built out of "an operator and a set of enum values". */
type SetCondition = Extract<WorkflowCondition, { type: 'ticket_status' | 'ticket_priority' }>;

/**
 * "Its status is one of Open, Waiting on customer." Usage: rendered by
 * `ConditionFields` for a `ticket_status` or `ticket_priority` condition.
 *
 * One component for both, because they are the same control twice: an operator
 * and a checkbox set over a closed enum. Two components differing only in which
 * label table they read would be the first place `not_in` got implemented once.
 *
 * The values and the operators both come from the **catalog**, so a console a
 * version behind cannot offer an operator the server would refuse; the labels
 * come from the content layer, falling back to the raw value for anything this
 * build does not know.
 */
export function SetConditionFields({
  condition,
  catalog,
  error,
  onChange,
}: {
  condition: SetCondition;
  catalog: WorkflowCatalogResponse;
  error?: string;
  onChange: (condition: WorkflowCondition) => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const isStatus = condition.type === 'ticket_status';
  const labels: Readonly<Record<string, string>> = isStatus
    ? content.ticketStatuses
    : content.ticketPriorities;

  return (
    <>
      <Field label={copy.operatorLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={condition.operator}
            options={labelledOptions(
              conditionOperatorValues(catalog, condition.type),
              copy.setOperators,
            )}
            onChange={(event) => {
              onChange({
                ...condition,
                operator: event.target.value === 'not_in' ? 'not_in' : 'in',
              });
            }}
          />
        )}
      </Field>

      <CheckboxGroup
        legend={isStatus ? copy.statusValuesLabel : copy.priorityValuesLabel}
        error={error}
        options={labelledCheckboxOptions(conditionValues(catalog, condition.type), labels)}
        selectedValues={condition.values}
        onChange={(values) => {
          // The cast is the checkbox group's price for being value-agnostic: the
          // options it was given are exactly this condition's own enum, so
          // anything it hands back is a member of it.
          onChange({ ...condition, values: [...values] } as WorkflowCondition);
        }}
      />
    </>
  );
}
