'use client';

import { useState } from 'react';
import type {
  WorkflowActionType,
  WorkflowCatalogResponse,
  WorkflowConditionType,
} from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import {
  actionTypeOptions,
  availableActionTypes,
  availableConditionTypes,
  conditionTypeOptions,
} from '../builder';
import type { WorkflowVocabulary } from '../presentation';
import styles from './WorkflowStepPalette.module.css';

/**
 * How a step gets onto the canvas. Usage:
 * `<WorkflowStepPalette catalog={catalog} vocabulary={vocabulary} conditionCount={…} … />`.
 *
 * A type picker beside each Add button, rather than the old fieldset's "add one
 * of whatever is first, then change its type": on a canvas the new node appears
 * immediately as a summary, and a node that says "Ticket status" when the
 * supervisor meant "Ticket age" is a step they then have to find and correct.
 *
 * **The caps come from `catalog.limits`, never from the imported
 * `WORKFLOW_LIMITS`.** A console a version behind must offer what the *server*
 * accepts — the rule `builder.ts` already establishes.
 */
export function WorkflowStepPalette({
  catalog,
  vocabulary,
  conditionCount,
  actionCount,
  onAddCondition,
  onAddAction,
}: {
  catalog: WorkflowCatalogResponse;
  vocabulary: WorkflowVocabulary;
  conditionCount: number;
  actionCount: number;
  onAddCondition: (type: WorkflowConditionType) => void;
  onAddAction: (type: WorkflowActionType) => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const conditionTypes = availableConditionTypes(catalog, vocabulary);
  const actionTypes = availableActionTypes(catalog, vocabulary);
  const [conditionType, setConditionType] = useState<string>(() => conditionTypes[0] ?? '');
  const [actionType, setActionType] = useState<string>(() => actionTypes[0] ?? '');

  const isConditionsFull = conditionCount >= catalog.limits.conditionsPerWorkflow;
  const isActionsFull = actionCount >= catalog.limits.actionsPerWorkflow;

  return (
    <div className={styles.palette}>
      <div className={styles.group}>
        <div className={styles.picker}>
          <Field label={copy.addConditionTypeLabel}>
            {({ controlId, describedBy }) => (
              <Select
                id={controlId}
                aria-describedby={describedBy}
                disabled={conditionTypes.length === 0 || isConditionsFull}
                value={conditionType}
                options={conditionTypeOptions(conditionTypes, content)}
                onChange={(event) => {
                  setConditionType(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
        <Button
          disabled={conditionType === '' || isConditionsFull}
          onClick={() => {
            onAddCondition(conditionType as WorkflowConditionType);
          }}
        >
          {copy.addCondition}
        </Button>
        {isConditionsFull ? (
          <p className={styles.hint}>
            {copy.conditionsFullHint(catalog.limits.conditionsPerWorkflow)}
          </p>
        ) : null}
      </div>

      <div className={styles.group}>
        <div className={styles.picker}>
          <Field label={copy.addActionTypeLabel}>
            {({ controlId, describedBy }) => (
              <Select
                id={controlId}
                aria-describedby={describedBy}
                disabled={actionTypes.length === 0 || isActionsFull}
                value={actionType}
                options={actionTypeOptions(actionTypes, content)}
                onChange={(event) => {
                  setActionType(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
        <Button
          disabled={actionType === '' || isActionsFull}
          onClick={() => {
            onAddAction(actionType as WorkflowActionType);
          }}
        >
          {copy.addAction}
        </Button>
        {isActionsFull ? (
          <p className={styles.hint}>{copy.actionsFullHint(catalog.limits.actionsPerWorkflow)}</p>
        ) : null}
      </div>
    </div>
  );
}
