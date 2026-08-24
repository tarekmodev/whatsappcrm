'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  WorkflowAction,
  WorkflowActionType,
  WorkflowCondition,
  WorkflowConditionType,
  WorkflowCreateInput,
  WorkflowResponse,
  WorkflowTestResponse,
  WorkflowTrigger,
} from '@whatsappcrm/contracts';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import {
  TRIGGER_NODE_ID,
  actionNodeId,
  addAction,
  addCondition,
  conditionNodeId,
  moveAction,
  removeNode,
  replaceNode,
  toGraph,
  type WorkflowGraph,
  type WorkflowNodeId,
} from './graph';
import type { WorkflowVocabulary } from './presentation';
import { createWorkflowAction, updateWorkflowAction } from './workflows.actions';
import {
  NO_WORKFLOW_ERRORS,
  draftFromWorkflow,
  validateWorkflowDraft,
  type WorkflowDraft,
  type WorkflowDraftErrors,
} from './workflow-form';

/**
 * The workflow canvas's state, and the one place a draft is changed.
 *
 * Extracted from the editor for the reason `workflow-form.ts` is pure: the rules
 * that are easy to get wrong — never arming a workflow by saving it, refusing to
 * dry-run a draft that is not what the server holds, putting the selection on
 * the step a refusal is about — are the parts worth testing, and none of them
 * need a DOM.
 *
 * **The draft is the state; the graph is a projection.** Every mutation below
 * goes through `graph.ts` and returns a new draft; `graph` is recomputed with
 * `useMemo` and nothing ever edits it. That is what makes the canvas impossible
 * to desynchronise from what will be saved.
 */

export interface UseWorkflowEditorOptions {
  /** `null` for `/settings/workflows/new` — a blank draft. */
  workflow: WorkflowResponse | null;
  /**
   * Resolves the ids a draft stores back into the names its summaries read out,
   * and supplies the blank shapes a new action starts from.
   *
   * The *catalog* is deliberately not here: what a workflow may hold is the
   * palette's and the inspector's business, and a hook that took it would be
   * carrying an argument for somebody else to use.
   */
  vocabulary: WorkflowVocabulary;
}

export interface WorkflowEditor {
  draft: WorkflowDraft;
  errors: WorkflowDraftErrors;
  graph: WorkflowGraph;
  selectedNodeId: WorkflowNodeId | null;
  /** Whether anything has been changed since the canvas opened. */
  isDirty: boolean;
  isPending: boolean;
  formError: string | null;
  requestId: string | null;
  /** The last dry run, or `null`. Cleared by any edit — see `mutate`. */
  test: WorkflowTestResponse | null;
  isEditing: boolean;
  select: (id: WorkflowNodeId) => void;
  setName: (name: string) => void;
  changeTrigger: (trigger: WorkflowTrigger) => void;
  changeCondition: (index: number, condition: WorkflowCondition) => void;
  changeAction: (index: number, action: WorkflowAction) => void;
  appendCondition: (type: WorkflowConditionType) => void;
  appendAction: (type: WorkflowActionType) => void;
  remove: (id: WorkflowNodeId) => void;
  move: (from: number, to: number) => void;
  setTest: (test: WorkflowTestResponse | null) => void;
  save: () => void;
  leave: () => void;
}

export function useWorkflowEditor({
  workflow,
  vocabulary,
}: UseWorkflowEditorOptions): WorkflowEditor {
  const content = useContent();
  const copy = content.workflows;
  const router = useRouter();
  const { showToast } = useToast();

  const [draft, setDraft] = useState<WorkflowDraft>(() => draftFromWorkflow(workflow));
  const [errors, setErrors] = useState<WorkflowDraftErrors>(NO_WORKFLOW_ERRORS);
  const [selectedNodeId, setSelectedNodeId] = useState<WorkflowNodeId | null>(TRIGGER_NODE_ID);
  const [test, setTest] = useState<WorkflowTestResponse | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  /**
   * What validation produced, handed to `perform` on the same tick `submit` is
   * called. A ref rather than state, for `WorkflowFormDialog`'s reason: a
   * `setState` in the submit handler is not visible to the callback that handler
   * goes on to invoke, so the send would always run one submit behind.
   */
  const validatedInputRef = useRef<WorkflowCreateInput | null>(null);
  const isEditing = workflow !== null;

  const perform = useCallback(async () => {
    const input = validatedInputRef.current;

    // Unreachable: `save` fills the ref before it calls `submit`.
    if (input === null) {
      throw new Error('Submitted a workflow before it was validated.');
    }

    return isEditing ? updateWorkflowAction(workflow.id, input) : createWorkflowAction(input);
  }, [isEditing, workflow]);

  const onSuccess = useCallback(
    ({ name }: { name: string }) => {
      setIsDirty(false);
      showToast({
        tone: 'success',
        message: isEditing ? copy.updateSuccess(name) : copy.createSuccess(name),
      });
      // Back to the list, which owns the on/off switch: a workflow that has just
      // been written is one a supervisor is about to dry-run and arm, and both
      // of those live there.
      router.push(routes.settingsWorkflows());
    },
    [copy, isEditing, router, showToast],
  );

  const { submit, isPending, formError, requestId, errorCode, clearError } = useActionForm({
    perform,
    onSuccess,
  });

  const graph = useMemo(
    () =>
      toGraph(draft, {
        errors,
        references: workflow?.references ?? [],
        test,
        vocabulary,
        content,
      }),
    [content, draft, errors, test, vocabulary, workflow],
  );

  /**
   * Every change to the draft, in one place.
   *
   * It clears the field errors, because they describe the draft as it was, and
   * it clears the dry run, because that describes a *ticket against the saved
   * workflow* — leaving it on the nodes after an edit would report a verdict on
   * a definition that is no longer what is on screen.
   */
  const mutate = useCallback(
    (change: (current: WorkflowDraft) => WorkflowDraft) => {
      setDraft(change);
      setErrors(NO_WORKFLOW_ERRORS);
      setTest(null);
      setIsDirty(true);
      clearError();
    },
    [clearError],
  );

  const save = useCallback(() => {
    const validation = validateWorkflowDraft(draft, content);

    if (validation.status === 'invalid') {
      setErrors(validation.errors);

      // Put the selection on the first step that needs attention, so the panel
      // beside the canvas is already showing the control the message is about.
      const offending = firstInvalidNode(validation.errors);

      if (offending !== null) {
        setSelectedNodeId(offending);
      }

      return;
    }

    setErrors(NO_WORKFLOW_ERRORS);
    validatedInputRef.current = validation.input;
    submit();
  }, [content, draft, submit]);

  /**
   * The API refused the save because something the workflow names is gone.
   *
   * The refusal carries `details[].path`, but `ActionResult` does not — it is
   * shared by every feature and widening it for this one is not TAR-812's to do.
   * `WorkflowResponse.references` is the same information the console already
   * holds, resolved by the same API for the same workflow, so the node it points
   * at is the node the refusal is about.
   */
  useEffect(() => {
    if (errorCode !== 'workflow_reference_broken') {
      return;
    }

    const broken = graph.nodes.find((node) => node.brokenReferences.length > 0);

    if (broken !== undefined) {
      setSelectedNodeId(broken.id);
    }
  }, [errorCode, graph]);

  /**
   * A full page load — a reload, a typed URL, the browser's back button leaving
   * the app — is the one navigation this component can still intercept.
   * In-app navigation is confirmed by the editor's own Cancel control instead;
   * the App Router exposes no route-change guard to hook.
   */
  useEffect(() => {
    if (!isDirty) {
      return;
    }

    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };

    window.addEventListener('beforeunload', warn);

    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [isDirty]);

  return {
    draft,
    errors,
    graph,
    selectedNodeId,
    isDirty,
    isPending,
    formError,
    requestId,
    test,
    isEditing,
    select: setSelectedNodeId,
    setName: useCallback(
      (name: string) => {
        mutate((current) => ({ ...current, name }));
      },
      [mutate],
    ),
    changeTrigger: useCallback(
      (trigger: WorkflowTrigger) => {
        mutate((current) => replaceNode(current, TRIGGER_NODE_ID, trigger));
      },
      [mutate],
    ),
    changeCondition: useCallback(
      (index: number, condition: WorkflowCondition) => {
        mutate((current) => replaceNode(current, conditionNodeId(index), condition));
      },
      [mutate],
    ),
    changeAction: useCallback(
      (index: number, action: WorkflowAction) => {
        mutate((current) => replaceNode(current, actionNodeId(index), action));
      },
      [mutate],
    ),
    appendCondition: useCallback(
      (type: WorkflowConditionType) => {
        setSelectedNodeId(conditionNodeId(draft.conditions.length));
        mutate((current) => addCondition(current, type));
      },
      [draft.conditions.length, mutate],
    ),
    appendAction: useCallback(
      (type: WorkflowActionType) => {
        setSelectedNodeId(actionNodeId(draft.actions.length));
        mutate((current) => addAction(current, type, vocabulary));
      },
      [draft.actions.length, mutate, vocabulary],
    ),
    remove: useCallback(
      (id: WorkflowNodeId) => {
        // Node identity is positional, so removing one renumbers everything
        // below it and the selected id would name a different step. The trigger
        // is always there and is the safe thing to land on.
        setSelectedNodeId(TRIGGER_NODE_ID);
        mutate((current) => removeNode(current, id));
      },
      [mutate],
    ),
    move: useCallback(
      (from: number, to: number) => {
        setSelectedNodeId(actionNodeId(to));
        mutate((current) => moveAction(current, from, to));
      },
      [mutate],
    ),
    setTest,
    save,
    leave: useCallback(() => {
      router.push(routes.settingsWorkflows());
    }, [router]),
  };
}

/** The step a failed validation is about, in the order the canvas reads. */
function firstInvalidNode(errors: WorkflowDraftErrors): WorkflowNodeId | null {
  if (errors.trigger !== undefined) {
    return TRIGGER_NODE_ID;
  }

  const conditionIndex = firstKey(errors.byCondition);

  if (conditionIndex !== null) {
    return conditionNodeId(conditionIndex);
  }

  const actionIndex = firstKey(errors.byAction);

  return actionIndex === null ? null : actionNodeId(actionIndex);
}

function firstKey(byIndex: Readonly<Record<number, string>>): number | null {
  const indexes = Object.keys(byIndex)
    .map(Number)
    .filter((index) => Number.isInteger(index))
    .sort((left, right) => left - right);

  return indexes[0] ?? null;
}
