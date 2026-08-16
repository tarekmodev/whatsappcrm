import {
  WORKFLOW_ELAPSED_MINUTES,
  WORKFLOW_FIELD_LENGTHS,
  WORKFLOW_LIMITS,
  WorkflowCreateInputSchema,
  workflowNotifyAudienceTarget,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowCreateInput,
  type WorkflowResponse,
  type WorkflowTrigger,
} from '@whatsappcrm/contracts';
import type { Content } from '@/lib/content';

/**
 * The workflow form's state, and the one function that decides whether it can be
 * submitted.
 *
 * Validation runs against the contract's own schema as the last step, so the
 * user is not sent on a round trip to learn that a field is empty — but the
 * per-field messages come first, because a schema failure says
 * `actions[1].userId` and a supervisor needs "choose who to notify", next to the
 * control it is about.
 *
 * Pure, so the rules that are easy to get wrong — a notify action whose audience
 * and target disagree, an edit that must not silently arm a disabled workflow —
 * are unit-testable without a DOM.
 */

export interface WorkflowDraft {
  readonly name: string;
  readonly trigger: WorkflowTrigger;
  readonly conditions: readonly WorkflowCondition[];
  readonly actions: readonly WorkflowAction[];
  /**
   * Carried, never edited here. The list owns the on/off switch; a form that
   * defaulted this would arm a workflow the moment somebody fixed a typo in its
   * name — and this one writes to tickets.
   */
  readonly isActive: boolean;
}

export interface WorkflowDraftErrors {
  readonly name?: string;
  readonly trigger?: string;
  /** A failure about the action list itself — that it is empty. */
  readonly actions?: string;
  /** Keyed by the condition's index in the draft. */
  readonly byCondition: Readonly<Record<number, string>>;
  /** Keyed by the action's index in the draft. */
  readonly byAction: Readonly<Record<number, string>>;
  /** A failure no field owns; shown above the actions. */
  readonly form?: string;
}

export type WorkflowDraftValidation =
  | { readonly status: 'valid'; readonly input: WorkflowCreateInput }
  | { readonly status: 'invalid'; readonly errors: WorkflowDraftErrors };

export const NO_WORKFLOW_ERRORS: WorkflowDraftErrors = { byCondition: {}, byAction: {} };

/**
 * A blank workflow, and the shape an existing one is edited from.
 *
 * A new one starts inactive and on `ticket_created`, the only trigger that needs
 * no parameter and the one a supervisor is most likely to mean by "when a ticket
 * comes in".
 */
export function draftFromWorkflow(workflow: WorkflowResponse | null): WorkflowDraft {
  if (workflow === null) {
    return {
      name: '',
      trigger: { type: 'ticket_created' },
      conditions: [],
      actions: [],
      isActive: false,
    };
  }

  return {
    name: workflow.name,
    trigger: workflow.trigger,
    conditions: [...workflow.conditions],
    actions: [...workflow.actions],
    isActive: workflow.isActive,
  };
}

export function validateWorkflowDraft(
  draft: WorkflowDraft,
  content: Content,
): WorkflowDraftValidation {
  const copy = content.workflows;
  const byCondition: Record<number, string> = {};
  const byAction: Record<number, string> = {};
  let name: string | undefined;
  let actions: string | undefined;

  const trimmedName = draft.name.trim();

  if (trimmedName.length === 0) {
    name = copy.nameRequiredError;
  } else if (trimmedName.length > WORKFLOW_FIELD_LENGTHS.name) {
    name = copy.nameTooLongError(WORKFLOW_FIELD_LENGTHS.name);
  }

  const trigger = triggerError(draft.trigger, content);

  draft.conditions.forEach((condition, index) => {
    const message = conditionError(condition, content);

    if (message !== null) {
      byCondition[index] = message;
    }
  });

  if (draft.actions.length === 0) {
    actions = copy.actionsRequiredError;
  }

  const cleanedActions = draft.actions.map((action, index) => {
    const cleaned = cleanAction(action);
    const message = actionError(cleaned, content);

    if (message !== null) {
      byAction[index] = message;
    }

    return cleaned;
  });

  const hasFieldError =
    name !== undefined ||
    trigger !== undefined ||
    actions !== undefined ||
    Object.keys(byCondition).length > 0 ||
    Object.keys(byAction).length > 0;

  if (hasFieldError) {
    return {
      status: 'invalid',
      errors: { name, trigger, actions, byCondition, byAction },
    };
  }

  const parsed = WorkflowCreateInputSchema.safeParse({
    name: trimmedName,
    trigger: draft.trigger,
    conditions: draft.conditions,
    actions: cleanedActions,
    isActive: draft.isActive,
  });

  if (!parsed.success) {
    // Everything above passed, so this is a grammar the form let through — a bug
    // rather than a user mistake. Say so generically instead of showing a Zod path.
    return {
      status: 'invalid',
      errors: { ...NO_WORKFLOW_ERRORS, form: content.form.genericSubmitError },
    };
  }

  return { status: 'valid', input: parsed.data };
}

/** Drops what the controls leave behind: an all-whitespace notify message. */
function cleanAction(action: WorkflowAction): WorkflowAction {
  if (action.type !== 'notify') {
    return action;
  }

  const message = action.message?.trim() ?? '';

  return { ...action, message: message.length === 0 ? null : message };
}

function triggerError(trigger: WorkflowTrigger, content: Content): string | undefined {
  if (trigger.type !== 'ticket_unresolved_for') {
    return undefined;
  }

  return isMinutesInRange(trigger.minutes)
    ? undefined
    : content.workflows.minutesRangeError(
        WORKFLOW_ELAPSED_MINUTES.min,
        WORKFLOW_ELAPSED_MINUTES.max,
      );
}

function conditionError(condition: WorkflowCondition, content: Content): string | null {
  const copy = content.workflows;

  switch (condition.type) {
    case 'ticket_status':
      return condition.values.length === 0 ? copy.statusValuesRequiredError : null;

    case 'ticket_priority':
      return condition.values.length === 0 ? copy.priorityValuesRequiredError : null;

    case 'ticket_tag':
    case 'contact_tag': {
      if (condition.tagIds.length === 0) {
        return copy.tagsRequiredError;
      }

      // The contract caps this and the checkbox group does not, so a workspace
      // with more tags than the cap can reach it by clicking.
      return condition.tagIds.length > WORKFLOW_LIMITS.valuesPerCondition
        ? copy.tagsTooManyError(WORKFLOW_LIMITS.valuesPerCondition)
        : null;
    }

    case 'ticket_age':
      // Age shares the elapsed trigger's ceiling but starts at one minute: it
      // reads a ticket that already exists rather than promising a sweep tick.
      return condition.minutes >= 1 && condition.minutes <= WORKFLOW_ELAPSED_MINUTES.max
        ? null
        : copy.minutesRangeError(1, WORKFLOW_ELAPSED_MINUTES.max);

    // Both are always complete: an assignment condition's null ids mean "any",
    // and business hours is a boolean.
    case 'ticket_assignment':
    case 'business_hours':
      return null;
  }
}

function actionError(action: WorkflowAction, content: Content): string | null {
  const copy = content.workflows;

  switch (action.type) {
    case 'add_ticket_tag':
      return action.tagId === '' ? copy.tagRequiredError : null;

    case 'reassign':
      return (action.target.kind === 'team' ? action.target.teamId : action.target.userId) === ''
        ? copy.assigneeRequiredError
        : null;

    case 'notify': {
      const target = workflowNotifyAudienceTarget(action.audience);

      if (target === 'user' && (action.userId ?? '') === '') {
        return copy.notifyUserRequiredError;
      }

      if (target === 'team' && (action.teamId ?? '') === '') {
        return copy.notifyTeamRequiredError;
      }

      return (action.message?.length ?? 0) > WORKFLOW_FIELD_LENGTHS.notifyMessage
        ? copy.messageTooLongError(WORKFLOW_FIELD_LENGTHS.notifyMessage)
        : null;
    }

    // A select always carries one of its values, so neither can be incomplete.
    case 'set_status':
    case 'set_priority':
      return null;
  }
}

function isMinutesInRange(minutes: number): boolean {
  return minutes >= WORKFLOW_ELAPSED_MINUTES.min && minutes <= WORKFLOW_ELAPSED_MINUTES.max;
}
