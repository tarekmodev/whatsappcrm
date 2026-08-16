'use client';

import type {
  WorkflowAction,
  WorkflowActionType,
  WorkflowCatalogResponse,
} from '@whatsappcrm/contracts';
import { EditorFieldset, EditorRow } from '@/components/ui/EditorFieldset';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { actionTypeOptions, availableActionTypes, blankAction } from '../builder';
import type { WorkflowVocabulary } from '../presentation';
import { ActionFields } from './ActionFields';

/**
 * What the workflow does, in the order it does it. Usage:
 * `<ActionListEditor actions={…} catalog={…} vocabulary={…} onChange={…} />`.
 *
 * **Order is meaning here, not presentation.** Actions run sequentially and a
 * failure stops the ones after it, because later actions usually assume the
 * earlier ones — "reassign to the escalation team, then notify that team" (ADR
 * 0009 decision 5). The legend says so, so nobody reads the list as a set.
 *
 * At least one action is required and the contract enforces it; the row's Remove
 * control stands down at one so the last one cannot be deleted into an invalid
 * workflow.
 */
export function ActionListEditor({
  actions,
  catalog,
  vocabulary,
  error,
  errorsByAction,
  onChange,
}: {
  actions: readonly WorkflowAction[];
  catalog: WorkflowCatalogResponse;
  vocabulary: WorkflowVocabulary;
  /** A failure about the list itself — that it is empty. */
  error?: string;
  errorsByAction: Readonly<Record<number, string>>;
  onChange: (actions: readonly WorkflowAction[]) => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const availableTypes = availableActionTypes(catalog, vocabulary);
  const isFull = actions.length >= catalog.limits.actionsPerWorkflow;

  function replaceAt(index: number, action: WorkflowAction): void {
    onChange(actions.map((current, position) => (position === index ? action : current)));
  }

  return (
    <EditorFieldset
      legend={copy.actionsLegend}
      hint={copy.actionsHint}
      error={error}
      addLabel={copy.addAction}
      isFull={isFull}
      fullHint={copy.actionsFullHint(catalog.limits.actionsPerWorkflow)}
      onAdd={() => {
        const type = availableTypes[0];

        if (type !== undefined) {
          onChange([...actions, blankAction(type, vocabulary)]);
        }
      }}
    >
      {actions.map((action, index) => (
        <EditorRow
          // Index as key: actions have no id of their own, and no row here holds
          // state that could be carried onto a neighbour when one is removed.
          key={index}
          heading={copy.actionNumber(index + 1)}
          removeLabel={copy.removeAction}
          removeAriaLabel={copy.removeActionAria(index + 1)}
          isRemovable={actions.length > 1}
          onRemove={() => {
            onChange(actions.filter((_unused, position) => position !== index));
          }}
        >
          <Field label={copy.actionTypeLabel}>
            {({ controlId, describedBy }) => (
              <Select
                id={controlId}
                aria-describedby={describedBy}
                value={action.type}
                options={actionTypeOptions(availableTypes, content)}
                onChange={(event) => {
                  replaceAt(
                    index,
                    blankAction(event.target.value as WorkflowActionType, vocabulary),
                  );
                }}
              />
            )}
          </Field>

          <ActionFields
            action={action}
            catalog={catalog}
            vocabulary={vocabulary}
            error={errorsByAction[index]}
            onChange={(next) => {
              replaceAt(index, next);
            }}
          />
        </EditorRow>
      ))}
    </EditorFieldset>
  );
}
