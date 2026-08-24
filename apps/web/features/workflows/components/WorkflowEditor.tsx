'use client';

import { useState } from 'react';
import {
  WORKFLOW_FIELD_LENGTHS,
  type WorkflowCatalogResponse,
  type WorkflowResponse,
} from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import { Notice } from '@/components/ui/Notice';
import { TextInput } from '@/components/ui/TextInput';
import { useContent } from '@/lib/content';
import { describeBrokenReferences, type WorkflowVocabulary } from '../presentation';
import { useWorkflowEditor } from '../useWorkflowEditor';
import { LazyWorkflowCanvas } from './workflow-canvas.lazy';
import { WorkflowDryRunBar } from './WorkflowDryRunBar';
import { WorkflowLeaveDialog } from './WorkflowLeaveDialog';
import { WorkflowNodeInspector } from './WorkflowNodeInspector';
import { WorkflowStepPalette } from './WorkflowStepPalette';
import styles from './WorkflowEditor.module.css';

/**
 * The workflow canvas route's one client component. Usage:
 * `<WorkflowEditor workflow={workflow} catalog={catalog} vocabulary={vocabulary} canWrite />`
 * — omit `workflow` to create one.
 *
 * Composition only, like the page above it: the state and every rule about it
 * live in `useWorkflowEditor`, and each region below is its own component with
 * its own module CSS. What is left here is the arrangement.
 *
 * One component for create and edit, rather than two that differ by a title: the
 * canvas, the inspector, the validation and the failure handling are identical,
 * and the two would drift the first time an action type is added.
 *
 * `isActive` is carried through the draft and never sent. The list owns the
 * on/off switch, so saving a name change cannot quietly arm a workflow that
 * writes to real tickets.
 */
export function WorkflowEditor({
  workflow = null,
  catalog,
  vocabulary,
  canWrite,
}: {
  workflow?: WorkflowResponse | null;
  catalog: WorkflowCatalogResponse;
  vocabulary: WorkflowVocabulary;
  canWrite: boolean;
}) {
  const content = useContent();
  const copy = content.workflows;
  const editor = useWorkflowEditor({ workflow, vocabulary });
  const [isLeaving, setIsLeaving] = useState(false);
  const broken = describeBrokenReferences(workflow?.references ?? [], content);

  return (
    <div className={styles.editor}>
      {canWrite ? null : <Notice tone="info">{copy.canvasReadOnly}</Notice>}

      {broken.length > 0 ? (
        <Notice tone="warning">{copy.brokenBody(broken.join(', '))}</Notice>
      ) : null}

      <div className={styles.header}>
        <div className={styles.name}>
          <Field label={copy.nameLabel} hint={copy.nameHint} error={editor.errors.name} isRequired>
            {({ controlId, describedBy, isInvalid }) => (
              <TextInput
                id={controlId}
                aria-describedby={describedBy}
                aria-invalid={isInvalid}
                name="name"
                autoComplete="off"
                disabled={!canWrite}
                maxLength={WORKFLOW_FIELD_LENGTHS.name}
                placeholder={copy.namePlaceholder}
                value={editor.draft.name}
                onChange={(event) => {
                  editor.setName(event.target.value);
                }}
              />
            )}
          </Field>
        </div>

        <div className={styles.actions}>
          {editor.isDirty ? <span className={styles.dirty}>{copy.canvasUnsaved}</span> : null}
          <Button
            onClick={() => {
              // Confirmed only when there is something to lose. A canvas opened
              // and closed unchanged should not ask a question.
              if (editor.isDirty) {
                setIsLeaving(true);
                return;
              }

              editor.leave();
            }}
          >
            {copy.canvasCancel}
          </Button>
          {canWrite ? (
            <Button variant="primary" isPending={editor.isPending} onClick={editor.save}>
              {editor.isEditing ? copy.canvasSaveExisting : copy.canvasSaveNew}
            </Button>
          ) : null}
        </div>
      </div>

      <FormError message={editor.errors.form ?? editor.formError} requestId={editor.requestId} />

      {editor.errors.actions === undefined ? null : (
        <Notice tone="danger">{editor.errors.actions}</Notice>
      )}

      {canWrite ? (
        <WorkflowStepPalette
          catalog={catalog}
          vocabulary={vocabulary}
          conditionCount={editor.draft.conditions.length}
          actionCount={editor.draft.actions.length}
          onAddCondition={editor.appendCondition}
          onAddAction={editor.appendAction}
        />
      ) : null}

      <div className={styles.surface}>
        <div className={styles.canvas}>
          <LazyWorkflowCanvas
            graph={editor.graph}
            selectedNodeId={editor.selectedNodeId}
            canWrite={canWrite}
            conditionCount={editor.draft.conditions.length}
            actionCount={editor.draft.actions.length}
            onSelect={editor.select}
            onMoveAction={editor.move}
          />
        </div>

        <WorkflowNodeInspector
          selectedNodeId={editor.selectedNodeId}
          draft={editor.draft}
          catalog={catalog}
          vocabulary={vocabulary}
          errors={editor.errors}
          canWrite={canWrite}
          onChangeTrigger={editor.changeTrigger}
          onChangeCondition={editor.changeCondition}
          onChangeAction={editor.changeAction}
          onRemove={editor.remove}
          onMoveAction={editor.move}
        />
      </div>

      {canWrite ? (
        <WorkflowDryRunBar
          workflowId={workflow?.id ?? null}
          isDirty={editor.isDirty}
          hasResult={editor.test !== null}
          onResult={editor.setTest}
        />
      ) : null}

      {isLeaving ? (
        <WorkflowLeaveDialog
          onStay={() => {
            setIsLeaving(false);
          }}
          onLeave={editor.leave}
        />
      ) : null}
    </div>
  );
}
