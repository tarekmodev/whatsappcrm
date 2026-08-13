'use client';

import { ROUTING_RULE_LIMITS, type RoutingCondition } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { Button } from '@/components/ui/Button';
import { useContent } from '@/lib/content';
import {
  availableConditionTypes,
  blankCondition,
  type RoutingRuleVocabulary,
} from '../presentation';
import { ConditionRow } from './ConditionRow';
import styles from './ConditionListEditor.module.css';

/**
 * The rule's condition list, and the controls that grow and shrink it. Usage:
 * `<ConditionListEditor conditions={…} vocabulary={…} onChange={…} />`.
 *
 * A real `fieldset`/`legend`, because the conditions are one question — "when
 * does this rule apply" — asked as several controls. The legend says every one of
 * them has to hold, which is the whole boolean model: conditions AND, rules OR.
 */
export function ConditionListEditor({
  conditions,
  vocabulary,
  error,
  errorsByCondition,
  onChange,
}: {
  conditions: readonly RoutingCondition[];
  vocabulary: RoutingRuleVocabulary;
  /** A failure about the list itself — that it is empty. */
  error?: string;
  errorsByCondition: Readonly<Record<number, string>>;
  onChange: (conditions: readonly RoutingCondition[]) => void;
}) {
  const content = useContent();
  const copy = content.routingRules;
  const availableTypes = availableConditionTypes(vocabulary);
  const isFull = conditions.length >= ROUTING_RULE_LIMITS.conditionsPerRule;

  function replaceAt(index: number, condition: RoutingCondition): void {
    onChange(conditions.map((current, position) => (position === index ? condition : current)));
  }

  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{copy.conditionsLegend}</legend>
      <p className={styles.hint}>{copy.conditionsHint}</p>
      {error === undefined ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <Stack gap="3" as="ul" className={styles.list}>
        {conditions.map((condition, index) => (
          <ConditionRow
            // Index as key: conditions have no id of their own. Removing one does
            // shift every index after it, so what makes this safe is that
            // `ConditionRow` holds no state of its own — every control is
            // controlled from `conditions` — and there is nothing for React to
            // carry onto the wrong row. Give a row local state and it needs a
            // real key first.
            key={index}
            condition={condition}
            index={index}
            availableTypes={availableTypes}
            vocabulary={vocabulary}
            error={errorsByCondition[index]}
            isRemovable={conditions.length > 1}
            onChange={(next) => {
              replaceAt(index, next);
            }}
            onRemove={() => {
              onChange(conditions.filter((_unused, position) => position !== index));
            }}
          />
        ))}
      </Stack>

      <Button
        variant="secondary"
        size="sm"
        disabled={isFull}
        onClick={() => {
          const type = availableTypes[0];

          if (type !== undefined) {
            onChange([...conditions, blankCondition(type, vocabulary)]);
          }
        }}
      >
        {copy.addCondition}
      </Button>
      {isFull ? (
        <p className={styles.hint}>
          {copy.conditionsFullHint(ROUTING_RULE_LIMITS.conditionsPerRule)}
        </p>
      ) : null}
    </fieldset>
  );
}
