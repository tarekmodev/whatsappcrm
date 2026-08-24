'use client';

import type {
  WorkflowAction,
  WorkflowActionType,
  WorkflowCatalogResponse,
  WorkflowCondition,
  WorkflowConditionType,
  WorkflowTrigger,
} from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import {
  actionTypeOptions,
  availableActionTypes,
  availableConditionTypes,
  blankAction,
  blankCondition,
  conditionTypeOptions,
} from '../builder';
import { parseNodeId, type WorkflowNodeId } from '../graph';
import type { WorkflowVocabulary } from '../presentation';
import type { WorkflowDraft, WorkflowDraftErrors } from '../workflow-form';
import { ActionFields } from './ActionFields';
import { ConditionFields } from './ConditionFields';
import { TriggerField } from './TriggerField';
import { WorkflowInspectorFrame } from './WorkflowInspectorFrame';
import styles from './WorkflowNodeInspector.module.css';

/**
 * Where the selected step is edited. Usage:
 * `<WorkflowNodeInspector selectedNodeId={…} draft={draft} catalog={catalog} … />`.
 *
 * **It reuses `TriggerField`, `ConditionFields` and `ActionFields` verbatim.**
 * That is TAR-809's shape and the reason the rebuild is shell-only: seven
 * condition editors and five action editors already typecheck, already handle
 * their own null-narrowings, and gain nothing from being rewritten as node
 * internals. A node card is a summary; this is the detail behind it.
 *
 * Nothing here holds workflow state. Every control reports a new value and the
 * editor above applies it to the draft, so the panel and the canvas are two
 * views of one thing rather than two things that have to agree — which is also
 * why a selection that outran the draft renders the empty state instead of half
 * a form over an index that is gone.
 */
export function WorkflowNodeInspector({
  selectedNodeId,
  draft,
  catalog,
  vocabulary,
  errors,
  canWrite,
  onChangeTrigger,
  onChangeCondition,
  onChangeAction,
  onRemove,
  onMoveAction,
}: {
  selectedNodeId: WorkflowNodeId | null;
  draft: WorkflowDraft;
  catalog: WorkflowCatalogResponse;
  vocabulary: WorkflowVocabulary;
  errors: WorkflowDraftErrors;
  canWrite: boolean;
  onChangeTrigger: (trigger: WorkflowTrigger) => void;
  onChangeCondition: (index: number, condition: WorkflowCondition) => void;
  onChangeAction: (index: number, action: WorkflowAction) => void;
  onRemove: (id: WorkflowNodeId) => void;
  onMoveAction: (from: number, to: number) => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const parsed = selectedNodeId === null ? null : parseNodeId(selectedNodeId);

  if (parsed === null || selectedNodeId === null) {
    return <EmptyInspector />;
  }

  if (parsed.kind === 'trigger') {
    return (
      <WorkflowInspectorFrame heading={copy.inspectorTriggerHeading}>
        <TriggerField
          trigger={draft.trigger}
          catalog={catalog}
          error={errors.trigger}
          onChange={onChangeTrigger}
        />
      </WorkflowInspectorFrame>
    );
  }

  const { index } = parsed;

  if (parsed.kind === 'condition') {
    const condition = draft.conditions[index];

    if (condition === undefined) {
      return <EmptyInspector />;
    }

    return (
      <WorkflowInspectorFrame
        heading={copy.inspectorConditionHeading(index + 1)}
        onRemove={
          canWrite
            ? () => {
                onRemove(selectedNodeId);
              }
            : undefined
        }
      >
        <Field label={copy.conditionTypeLabel}>
          {({ controlId, describedBy }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              disabled={!canWrite}
              value={condition.type}
              options={conditionTypeOptions(availableConditionTypes(catalog, vocabulary), content)}
              onChange={(event) => {
                // A blank of the new type rather than a carry-across: a status
                // set is not a tag set, and a half-migrated condition is a shape
                // the contract refuses for reasons the supervisor cannot see.
                onChangeCondition(
                  index,
                  blankCondition(event.target.value as WorkflowConditionType),
                );
              }}
            />
          )}
        </Field>

        <ConditionFields
          condition={condition}
          catalog={catalog}
          vocabulary={vocabulary}
          error={errors.byCondition[index]}
          onChange={(next) => {
            onChangeCondition(index, next);
          }}
        />
      </WorkflowInspectorFrame>
    );
  }

  const action = draft.actions[index];

  if (action === undefined) {
    return <EmptyInspector />;
  }

  return (
    <WorkflowInspectorFrame
      heading={copy.inspectorActionHeading(index + 1)}
      // The contract requires at least one action, so the last one cannot be
      // deleted into a workflow the API would refuse.
      onRemove={
        canWrite && draft.actions.length > 1
          ? () => {
              onRemove(selectedNodeId);
            }
          : undefined
      }
      move={canWrite ? { index, count: draft.actions.length, onMove: onMoveAction } : undefined}
    >
      <Field label={copy.actionTypeLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            disabled={!canWrite}
            value={action.type}
            options={actionTypeOptions(availableActionTypes(catalog, vocabulary), content)}
            onChange={(event) => {
              onChangeAction(
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
        error={errors.byAction[index]}
        onChange={(next) => {
          onChangeAction(index, next);
        }}
      />
    </WorkflowInspectorFrame>
  );
}

/** Nothing selected, or a selection the draft no longer has a step for. */
function EmptyInspector() {
  const content = useContent();
  const copy = content.workflows;

  return (
    <section className={styles.panel} aria-label={copy.inspectorLabel}>
      <div className={styles.empty}>
        <h3 className={styles.heading}>{copy.inspectorEmptyHeading}</h3>
        <p className={styles.emptyBody}>{copy.inspectorEmptyBody}</p>
      </div>
    </section>
  );
}
