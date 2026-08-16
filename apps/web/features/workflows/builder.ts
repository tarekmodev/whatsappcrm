import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  WORKFLOW_ASSIGNMENT_STATES,
  WORKFLOW_ELAPSED_MINUTES,
  type TicketPriority,
  type TicketStatus,
  type WorkflowAction,
  type WorkflowActionType,
  type WorkflowAssignmentState,
  type WorkflowCatalogResponse,
  type WorkflowCondition,
  type WorkflowConditionType,
  type WorkflowNotifyAudience,
  type WorkflowTrigger,
  type WorkflowTriggerType,
} from '@whatsappcrm/contracts';
import type { CheckboxOption } from '@/components/ui/CheckboxGroup';
import type { SelectOption } from '@/components/ui/Select';
import type { Content } from '@/lib/content';
import type { WorkflowVocabulary } from './presentation';

/**
 * What the builder form may offer, and the blank shapes it starts from.
 *
 * **Every option list comes from the catalog**, not from the contract constants
 * this bundle happens to carry. ADR 0009 makes `GET /workflow-catalog` an
 * endpoint precisely so a console running a version behind cannot offer an
 * action the API refuses; reading the constants directly here would throw that
 * away. The constants are still imported, but only for the *types* and for the
 * defaults a blank condition starts at.
 *
 * Pure, so the rules that are easy to get wrong — clearing a notify target when
 * the audience changes, dropping a tag condition in a workspace with no tags —
 * are unit-testable without a DOM.
 */

/** An hour, as the age a new elapsed trigger or age condition starts at. */
const DEFAULT_MINUTES = 60;

// --- What the form may offer -----------------------------------------------

export function availableTriggerTypes(
  catalog: WorkflowCatalogResponse,
): readonly WorkflowTriggerType[] {
  return catalog.triggers.map((trigger) => trigger.type);
}

/**
 * The condition types the form offers.
 *
 * Tag conditions are dropped when the workspace has no tags: a tag condition
 * with nothing to choose from can only ever be an invalid workflow, and offering
 * it would send the supervisor to a refusal.
 */
export function availableConditionTypes(
  catalog: WorkflowCatalogResponse,
  vocabulary: WorkflowVocabulary,
): readonly WorkflowConditionType[] {
  return catalog.conditions
    .filter((condition) => condition.taxonomy !== 'tag' || vocabulary.tags.length > 0)
    .map((condition) => condition.type);
}

/**
 * The action types the form offers, on the same rule.
 *
 * `add_ticket_tag` needs a tag to apply, and `reassign` needs somebody to
 * reassign to — a workspace with no teams and no active agents has neither.
 */
export function availableActionTypes(
  catalog: WorkflowCatalogResponse,
  vocabulary: WorkflowVocabulary,
): readonly WorkflowActionType[] {
  return catalog.actions
    .map((action) => action.type)
    .filter((type) => {
      if (type === 'add_ticket_tag') {
        return vocabulary.tags.length > 0;
      }

      if (type === 'reassign') {
        return vocabulary.teams.length > 0 || activeUsers(vocabulary).length > 0;
      }

      return true;
    });
}

/** The values one condition type compares against, as the catalog published them. */
export function conditionValues(
  catalog: WorkflowCatalogResponse,
  type: WorkflowConditionType,
): readonly string[] {
  return catalog.conditions.find((condition) => condition.type === type)?.values ?? [];
}

/** The operators one condition type offers, as the catalog published them. */
export function conditionOperatorValues(
  catalog: WorkflowCatalogResponse,
  type: WorkflowConditionType,
): readonly string[] {
  return catalog.conditions.find((condition) => condition.type === type)?.operators ?? [];
}

/**
 * The values one action parameter accepts, as the catalog published them —
 * `set_status`'s statuses, `set_priority`'s priorities.
 */
export function actionParameterValues(
  catalog: WorkflowCatalogResponse,
  type: WorkflowActionType,
  parameterName: string,
): readonly string[] {
  return (
    catalog.actions
      .find((action) => action.type === type)
      ?.parameters.find((candidate) => candidate.name === parameterName)?.values ?? []
  );
}

// --- Option lists ----------------------------------------------------------

export function triggerTypeOptions(
  types: readonly WorkflowTriggerType[],
  content: Content,
): readonly SelectOption[] {
  return types.map((type) => ({ value: type, label: content.workflows.triggerTypes[type] }));
}

export function conditionTypeOptions(
  types: readonly WorkflowConditionType[],
  content: Content,
): readonly SelectOption[] {
  return types.map((type) => ({ value: type, label: content.workflows.conditionTypes[type] }));
}

export function actionTypeOptions(
  types: readonly WorkflowActionType[],
  content: Content,
): readonly SelectOption[] {
  return types.map((type) => ({ value: type, label: content.workflows.actionTypes[type] }));
}

/**
 * Labels a catalog's raw values through the content layer, falling back to the
 * value itself for anything this build does not recognise — the same leniency
 * `ApiErrorCodeSchema` keeps for a code shipped by a newer API. A console a
 * version behind shows an unfamiliar option by name rather than blank.
 */
export function labelledOptions(
  values: readonly string[],
  labels: Readonly<Record<string, string>>,
): readonly SelectOption[] {
  return values.map((value) => ({ value, label: labels[value] ?? value }));
}

export function labelledCheckboxOptions(
  values: readonly string[],
  labels: Readonly<Record<string, string>>,
): readonly CheckboxOption[] {
  return values.map((value) => ({ value, label: labels[value] ?? value }));
}

export function teamOptions(vocabulary: WorkflowVocabulary): readonly SelectOption[] {
  return vocabulary.teams.map((team) => ({ value: team.id, label: team.name }));
}

/**
 * Only agents who can actually take the work, plus whoever the workflow already
 * names — kept listed so the current value is visible rather than blank.
 */
export function userOptions(
  vocabulary: WorkflowVocabulary,
  currentUserId: string | null,
): readonly SelectOption[] {
  return vocabulary.users
    .filter((user) => user.status === 'active' || user.id === currentUserId)
    .map((user) => ({ value: user.id, label: user.displayName }));
}

export function tagOptions(vocabulary: WorkflowVocabulary): readonly CheckboxOption[] {
  return vocabulary.tags.map((tag) => ({ value: tag.id, label: tag.name }));
}

export function tagSelectOptions(vocabulary: WorkflowVocabulary): readonly SelectOption[] {
  return vocabulary.tags.map((tag) => ({ value: tag.id, label: tag.name }));
}

/**
 * A native select always has a value, so an unchosen reference needs an explicit
 * empty option — otherwise the first team looks "selected" without anyone
 * choosing it, and a workflow gets a target its author never picked.
 */
export function withPlaceholder(
  options: readonly SelectOption[],
  placeholder: string,
): readonly SelectOption[] {
  return [{ value: '', label: placeholder }, ...options];
}

// --- Blank shapes ----------------------------------------------------------

/**
 * A trigger of the chosen type. Switching type replaces it rather than carrying
 * values across: there is nothing meaningful to carry from "a ticket is created"
 * to "unresolved for N minutes".
 */
export function blankTrigger(type: WorkflowTriggerType): WorkflowTrigger {
  return type === 'ticket_unresolved_for' ? { type, minutes: DEFAULT_MINUTES } : { type };
}

/**
 * A newly added condition, valid enough to render but not yet to submit — the
 * form's own validation is what stops an empty one being sent.
 */
export function blankCondition(type: WorkflowConditionType): WorkflowCondition {
  switch (type) {
    case 'ticket_status':
      return { type, operator: 'in', values: [] };

    case 'ticket_priority':
      return { type, operator: 'in', values: [] };

    case 'ticket_assignment':
      return { type, state: 'unassigned', teamId: null, userId: null };

    case 'ticket_tag':
    case 'contact_tag':
      return { type, match: 'any', tagIds: [] };

    case 'ticket_age':
      return { type, operator: 'gte', minutes: DEFAULT_MINUTES };

    case 'business_hours':
      return { type, within: false };
  }
}

/**
 * A newly added action.
 *
 * `set_status` and `set_priority` start at the *first* value of their enum
 * rather than at a guess about intent. A select always has a value, so any
 * default is one the author did not choose; starting at `open`/`low` means the
 * least destructive of them, and the workflow is inactive on create and has a
 * dry run before it is armed.
 */
export function blankAction(
  type: WorkflowActionType,
  vocabulary: WorkflowVocabulary,
): WorkflowAction {
  switch (type) {
    case 'add_ticket_tag':
      return { type, tagId: vocabulary.tags[0]?.id ?? '' };

    case 'reassign':
      return { type, target: { kind: 'team', teamId: '' } };

    case 'notify':
      return { type, audience: 'supervisors', userId: null, teamId: null, message: null };

    case 'set_status':
      return { type, status: TICKET_STATUSES[0] as TicketStatus };

    case 'set_priority':
      return { type, priority: TICKET_PRIORITIES[0] as TicketPriority };
  }
}

// --- Normalisers -----------------------------------------------------------

/**
 * Normalises an assignment condition after its state changed, so `teamId` and
 * `userId` are non-null only where that state permits — the invariant the
 * contract refines on, kept here so no caller has to remember it.
 */
export function withAssignmentState(
  condition: Extract<WorkflowCondition, { type: 'ticket_assignment' }>,
  state: WorkflowAssignmentState,
): WorkflowCondition {
  return {
    ...condition,
    state,
    teamId: state === 'assigned_to_team' ? condition.teamId : null,
    userId: state === 'assigned_to_user' ? condition.userId : null,
  };
}

/** The same rule for `notify`: exactly one id, and only the one its audience takes. */
export function withNotifyAudience(
  action: Extract<WorkflowAction, { type: 'notify' }>,
  audience: WorkflowNotifyAudience,
): WorkflowAction {
  return {
    ...action,
    audience,
    userId: audience === 'user' ? action.userId : null,
    teamId: audience === 'team' ? action.teamId : null,
  };
}

/** The elapsed-trigger and age bounds, so a form's `min`/`max` cannot drift. */
export const MINUTES_BOUNDS = WORKFLOW_ELAPSED_MINUTES;

export const ASSIGNMENT_STATES: readonly WorkflowAssignmentState[] = WORKFLOW_ASSIGNMENT_STATES;

function activeUsers(
  vocabulary: WorkflowVocabulary,
): readonly WorkflowVocabulary['users'][number][] {
  return vocabulary.users.filter((user) => user.status === 'active');
}
