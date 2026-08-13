'use client';

import {
  ROUTING_RULE_FIELD_LENGTHS,
  type ContactAttributeCondition,
  type ContactAttributeOperator,
  type CustomFieldDefinition,
} from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select, type SelectOption } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/TextInput';
import { useContent } from '@/lib/content';
import { operatorOptions, withOperator } from '../presentation';

/**
 * "Plan tier is exactly gold." Usage: rendered by `ConditionFields` for a
 * `contact_attribute` condition.
 *
 * The field is a dropdown of the workspace's own custom fields rather than a text
 * box, because the contract requires the key to name a real `custom_field_defs`
 * row — a typed attribute path would be a rule that silently never matches.
 *
 * The value input disappears for `is filled in` and `is empty`, and `withOperator`
 * nulls the value at the same time, so the two can never disagree.
 *
 * A field the rule references that no longer exists keeps its own option, so the
 * select shows what the condition actually holds and can be pointed somewhere
 * else. Without it the control would display the first field while the condition
 * still carried the dead key, and every save would be refused for a reason the
 * screen contradicted.
 */
export function ContactAttributeConditionFields({
  condition,
  customFields,
  error,
  onChange,
}: {
  condition: ContactAttributeCondition;
  customFields: readonly CustomFieldDefinition[];
  error?: string;
  onChange: (condition: ContactAttributeCondition) => void;
}) {
  const content = useContent();
  const copy = content.routingRules;

  return (
    <>
      <Field label={copy.attributeKeyLabel} isRequired>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={condition.key}
            options={fieldOptions(customFields, condition.key, copy.summaryUnknownReference)}
            onChange={(event) => {
              onChange({ ...condition, key: event.target.value });
            }}
          />
        )}
      </Field>

      <Field label={copy.attributeOperatorLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={condition.operator}
            options={operatorOptions(content)}
            onChange={(event) => {
              onChange(withOperator(condition, event.target.value as ContactAttributeOperator));
            }}
          />
        )}
      </Field>

      {condition.value === null ? null : (
        <Field label={copy.attributeValueLabel} error={error} isRequired>
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              maxLength={ROUTING_RULE_FIELD_LENGTHS.attributeValue}
              value={condition.value ?? ''}
              onChange={(event) => {
                onChange({ ...condition, value: event.target.value });
              }}
            />
          )}
        </Field>
      )}
    </>
  );
}

/**
 * The workspace's fields, plus the condition's own key when it no longer names
 * one — labelled the way the rule summary labels it, so the select shows what the
 * condition actually holds rather than silently displaying a different field.
 */
function fieldOptions(
  customFields: readonly CustomFieldDefinition[],
  selectedKey: string,
  unknownLabel: string,
): readonly SelectOption[] {
  const options = customFields.map((definition) => ({
    value: definition.key,
    label: definition.label,
  }));

  return options.some((option) => option.value === selectedKey)
    ? options
    : [...options, { value: selectedKey, label: unknownLabel }];
}
