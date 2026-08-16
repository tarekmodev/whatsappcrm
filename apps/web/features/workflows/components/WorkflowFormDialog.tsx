'use client';

import { useCallback, useRef, useState } from 'react';
import {
  WORKFLOW_FIELD_LENGTHS,
  type WorkflowCatalogResponse,
  type WorkflowCreateInput,
  type WorkflowResponse,
} from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Notice } from '@/components/ui/Notice';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { describeBrokenReferences, type WorkflowVocabulary } from '../presentation';
import { createWorkflowAction, updateWorkflowAction } from '../workflows.actions';
import {
  NO_WORKFLOW_ERRORS,
  draftFromWorkflow,
  validateWorkflowDraft,
  type WorkflowDraft,
  type WorkflowDraftErrors,
} from '../workflow-form';
import { ActionListEditor } from './ActionListEditor';
import { ConditionListEditor } from './ConditionListEditor';
import { TriggerField } from './TriggerField';

/**
 * Writes a workflow. Usage:
 * `<WorkflowFormDialog workflow={workflow} catalog={catalog} vocabulary={vocabulary} onClose={…} />`
 * — omit `workflow` to create one. Mounted only while open, so its chunk loads
 * on first use.
 *
 * One component for both, rather than a create dialog and an edit dialog that
 * differ by a title: the fields, the validation and the failure handling are
 * identical, and the two would drift the first time an action type is added.
 *
 * `isActive` is carried through the draft and never edited here. The list owns
 * the on/off switch, so saving a name change cannot quietly arm a workflow that
 * writes to tickets.
 */
export function WorkflowFormDialog({
  workflow = null,
  catalog,
  vocabulary,
  onClose,
}: {
  workflow?: WorkflowResponse | null;
  catalog: WorkflowCatalogResponse;
  vocabulary: WorkflowVocabulary;
  onClose: () => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const { showToast } = useToast();
  const [draft, setDraft] = useState<WorkflowDraft>(() => draftFromWorkflow(workflow));
  const [errors, setErrors] = useState<WorkflowDraftErrors>(NO_WORKFLOW_ERRORS);
  /**
   * What validation produced, handed to `perform` on the same tick `submit` is
   * called. A ref rather than state: a `setState` in the submit handler is not
   * visible to the callback that handler goes on to invoke, so the send would
   * always run one submit behind.
   */
  const validatedInputRef = useRef<WorkflowCreateInput | null>(null);
  const isEditing = workflow !== null;
  const broken = describeBrokenReferences(workflow?.references ?? [], content);

  const perform = useCallback(async () => {
    const input = validatedInputRef.current;

    // Unreachable: `onSubmit` fills the ref before it calls `submit`.
    if (input === null) {
      throw new Error('Submitted a workflow before it was validated.');
    }

    return isEditing ? updateWorkflowAction(workflow.id, input) : createWorkflowAction(input);
  }, [isEditing, workflow]);

  const onSuccess = useCallback(
    ({ name }: { name: string }) => {
      showToast({
        tone: 'success',
        message: isEditing ? copy.updateSuccess(name) : copy.createSuccess(name),
      });
      onClose();
    },
    [copy, isEditing, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  function update(change: Partial<WorkflowDraft>): void {
    setDraft((current) => ({ ...current, ...change }));
    setErrors(NO_WORKFLOW_ERRORS);
  }

  return (
    <FormDialog
      isOpen
      title={isEditing ? copy.editWorkflowTitle(workflow.name) : copy.addWorkflowTitle}
      submitLabel={isEditing ? copy.editWorkflowSubmit : copy.addWorkflowSubmit}
      isPending={isPending}
      formError={errors.form ?? formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        const validation = validateWorkflowDraft(draft, content);

        if (validation.status === 'invalid') {
          setErrors(validation.errors);
          return;
        }

        setErrors(NO_WORKFLOW_ERRORS);
        validatedInputRef.current = validation.input;
        submit();
      }}
    >
      {broken.length > 0 ? (
        <Notice tone="warning">{copy.brokenBody(broken.join(', '))}</Notice>
      ) : null}

      <Field label={copy.nameLabel} hint={copy.nameHint} error={errors.name} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="name"
            autoComplete="off"
            maxLength={WORKFLOW_FIELD_LENGTHS.name}
            placeholder={copy.namePlaceholder}
            value={draft.name}
            onChange={(event) => {
              update({ name: event.target.value });
            }}
          />
        )}
      </Field>

      <TriggerField
        trigger={draft.trigger}
        catalog={catalog}
        error={errors.trigger}
        onChange={(trigger) => {
          update({ trigger });
        }}
      />

      <ConditionListEditor
        conditions={draft.conditions}
        catalog={catalog}
        vocabulary={vocabulary}
        errorsByCondition={errors.byCondition}
        onChange={(conditions) => {
          update({ conditions });
        }}
      />

      <ActionListEditor
        actions={draft.actions}
        catalog={catalog}
        vocabulary={vocabulary}
        error={errors.actions}
        errorsByAction={errors.byAction}
        onChange={(actions) => {
          update({ actions });
        }}
      />
    </FormDialog>
  );
}
