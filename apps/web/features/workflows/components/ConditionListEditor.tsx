'use client';

import type {
  WorkflowCatalogResponse,
  WorkflowCondition,
  WorkflowConditionType,
} from '@whatsappcrm/contracts';
import { EditorFieldset, EditorRow } from '@/components/ui/EditorFieldset';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { availableConditionTypes, blankCondition, conditionTypeOptions } from '../builder';
import type { WorkflowVocabulary } from '../presentation';
import { ConditionFields } from './ConditionFields';

/**
 * The workflow's condition list, and the controls that grow and shrink it.
 * Usage: `<ConditionListEditor conditions={…} catalog={…} vocabulary={…} onChange={…} />`.
 *
 * **An empty list is valid here**, unlike a routing rule's, and the legend says
 * so: a workflow with no conditions means "every time this trigger fires, do
 * this", which is a legitimate automation and cannot swallow anything, because
 * every other workflow still runs (ADR 0009 decision 4).
 *
 * Changing a row's type replaces the condition with a blank one of the new type
 * rather than carrying values across: a status set is not a tag set, and a
 * half-migrated condition would be a shape the contract refuses for reasons the
 * user cannot see.
 */
export function ConditionListEditor({
  conditions,
  catalog,
  vocabulary,
  errorsByCondition,
  onChange,
}: {
  conditions: readonly WorkflowCondition[];
  catalog: WorkflowCatalogResponse;
  vocabulary: WorkflowVocabulary;
  errorsByCondition: Readonly<Record<number, string>>;
  onChange: (conditions: readonly WorkflowCondition[]) => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const availableTypes = availableConditionTypes(catalog, vocabulary);
  const isFull = conditions.length >= catalog.limits.conditionsPerWorkflow;

  function replaceAt(index: number, condition: WorkflowCondition): void {
    onChange(conditions.map((current, position) => (position === index ? condition : current)));
  }

  return (
    <EditorFieldset
      legend={copy.conditionsLegend}
      hint={copy.conditionsHint}
      addLabel={copy.addCondition}
      isFull={isFull}
      fullHint={copy.conditionsFullHint(catalog.limits.conditionsPerWorkflow)}
      onAdd={() => {
        const type = availableTypes[0];

        if (type !== undefined) {
          onChange([...conditions, blankCondition(type)]);
        }
      }}
    >
      {conditions.map((condition, index) => (
        <EditorRow
          // Index as key: conditions have no id of their own. Removing one does
          // shift every index after it, so what makes this safe is that the row
          // holds no state of its own — every control is controlled from
          // `conditions` — and there is nothing for React to carry onto the
          // wrong row.
          key={index}
          heading={copy.conditionNumber(index + 1)}
          removeLabel={copy.removeCondition}
          removeAriaLabel={copy.removeConditionAria(index + 1)}
          isRemovable
          onRemove={() => {
            onChange(conditions.filter((_unused, position) => position !== index));
          }}
        >
          <Field label={copy.conditionTypeLabel}>
            {({ controlId, describedBy }) => (
              <Select
                id={controlId}
                aria-describedby={describedBy}
                value={condition.type}
                options={conditionTypeOptions(availableTypes, content)}
                onChange={(event) => {
                  replaceAt(index, blankCondition(event.target.value as WorkflowConditionType));
                }}
              />
            )}
          </Field>

          <ConditionFields
            condition={condition}
            catalog={catalog}
            vocabulary={vocabulary}
            error={errorsByCondition[index]}
            onChange={(next) => {
              replaceAt(index, next);
            }}
          />
        </EditorRow>
      ))}
    </EditorFieldset>
  );
}
