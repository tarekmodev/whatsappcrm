'use client';

import type {
  WorkflowCatalogResponse,
  WorkflowCondition,
  WorkflowNumberOperator,
} from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/TextInput';
import { useContent } from '@/lib/content';
import { MINUTES_BOUNDS, conditionOperatorValues, labelledOptions } from '../builder';

type AgeCondition = Extract<WorkflowCondition, { type: 'ticket_age' }>;

/**
 * "It is at least 4 hours old." Usage: rendered by `ConditionFields` for a
 * `ticket_age` condition.
 *
 * Minutes rather than a value-and-unit pair, because minutes are what the
 * contract carries and a unit select would be a second control whose only job is
 * to multiply. The card reads the number back as the largest whole unit it
 * divides into, so "240" is entered once and shown as "4 hours" from then on.
 *
 * The floor is one minute, not the elapsed trigger's five: this reads a ticket
 * that already exists rather than promising a sweep will notice within a tick.
 */
export function AgeConditionFields({
  condition,
  catalog,
  error,
  onChange,
}: {
  condition: AgeCondition;
  catalog: WorkflowCatalogResponse;
  error?: string;
  onChange: (condition: WorkflowCondition) => void;
}) {
  const content = useContent();
  const copy = content.workflows;

  return (
    <>
      <Field label={copy.operatorLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={condition.operator}
            options={labelledOptions(
              conditionOperatorValues(catalog, 'ticket_age'),
              copy.numberOperators,
            )}
            onChange={(event) => {
              onChange({ ...condition, operator: event.target.value as WorkflowNumberOperator });
            }}
          />
        )}
      </Field>

      <Field label={copy.ageMinutesLabel} error={error} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            type="number"
            inputMode="numeric"
            min={1}
            max={MINUTES_BOUNDS.max}
            step={1}
            name="ageMinutes"
            value={String(condition.minutes)}
            onChange={(event) => {
              onChange({ ...condition, minutes: Number(event.target.value) });
            }}
          />
        )}
      </Field>
    </>
  );
}
