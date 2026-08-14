'use client';

import type { RoutingCondition, RoutingConditionType } from '@whatsappcrm/contracts';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { blankCondition, conditionTypeOptions, type RoutingRuleVocabulary } from '../presentation';
import { ConditionFields } from './ConditionFields';
import styles from './ConditionRow.module.css';

/**
 * One condition in the rule form: its type picker, its own controls, and the
 * control that removes it. Usage: rendered by `ConditionListEditor` per condition.
 *
 * Changing the type replaces the condition with a blank one of the new type
 * rather than trying to carry values across. There is nothing meaningful to carry
 * — a keyword list is not a tag set — and a half-migrated condition would be a
 * shape the contract refuses for reasons the user cannot see.
 */
export function ConditionRow({
  condition,
  index,
  availableTypes,
  vocabulary,
  error,
  isRemovable,
  onChange,
  onRemove,
}: {
  condition: RoutingCondition;
  /** Zero-based; the heading and the remove control both show it one-based. */
  index: number;
  availableTypes: readonly RoutingConditionType[];
  vocabulary: RoutingRuleVocabulary;
  error?: string;
  isRemovable: boolean;
  onChange: (condition: RoutingCondition) => void;
  onRemove: () => void;
}) {
  const content = useContent();
  const copy = content.routingRules;
  const position = index + 1;

  return (
    <li className={styles.row}>
      <Cluster justify="between" align="center" gap="2">
        <h4 className={styles.heading}>{copy.conditionNumber(position)}</h4>
        {isRemovable ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={copy.removeConditionAria(position)}
            onClick={onRemove}
          >
            {copy.removeCondition}
          </Button>
        ) : null}
      </Cluster>

      <Stack gap="3">
        <Field label={copy.conditionTypeLabel}>
          {({ controlId, describedBy }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              value={condition.type}
              options={conditionTypeOptions(availableTypes, content)}
              onChange={(event) => {
                onChange(blankCondition(event.target.value as RoutingConditionType, vocabulary));
              }}
            />
          )}
        </Field>

        <ConditionFields
          condition={condition}
          vocabulary={vocabulary}
          error={error}
          onChange={onChange}
        />
      </Stack>
    </li>
  );
}
