import {
  workflowNotifyAudienceTarget,
  type Tag,
  type TeamResponse,
  type UserResponse,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowMatchOperator,
  type WorkflowReference,
  type WorkflowTaxonomyKind,
  type WorkflowTrigger,
} from '@whatsappcrm/contracts';
import { formatMinutes } from '@/lib/format/duration';
import type { Content } from '@/lib/content';

/**
 * Turns a workflow's grammar into the sentences a supervisor reads: when it
 * fires, what it checks and what it does.
 *
 * Pure and free of React on purpose — "what does this rule actually do" is the
 * thing about this surface most worth testing, and it needs no DOM. The option
 * lists the *form* offers live in `builder.ts`; this module only reads.
 */

/** Everything a condition or action can point at, resolved once per render. */
export interface WorkflowVocabulary {
  readonly teams: readonly TeamResponse[];
  readonly users: readonly UserResponse[];
  readonly tags: readonly Tag[];
}

export const EMPTY_WORKFLOW_VOCABULARY: WorkflowVocabulary = { teams: [], users: [], tags: [] };

/** A resolved name, or `null` for a reference that no longer exists. */
export type ReferenceLookup = (kind: WorkflowTaxonomyKind, id: string) => string | null;

/**
 * Names for the ids a definition stores.
 *
 * `WorkflowResponse.references` wins over the vocabulary, because the API
 * resolves it live against the tenant's current rows and reports `exists: false`
 * for anything that is gone (ADR 0009 decision 6). The vocabulary is the
 * fallback for what no response carries — a draft in the form, which has not
 * been saved and so has no `references` of its own yet.
 */
export function createReferenceLookup(
  references: readonly WorkflowReference[],
  vocabulary: WorkflowVocabulary,
): ReferenceLookup {
  const resolved = new Map(
    references.map((reference) => [`${reference.kind}:${reference.id}`, reference.name]),
  );

  return (kind, id) => {
    const fromResponse = resolved.get(`${kind}:${id}`);

    if (fromResponse !== undefined) {
      return fromResponse;
    }

    switch (kind) {
      case 'tag':
        return vocabulary.tags.find((tag) => tag.id === id)?.name ?? null;
      case 'team':
        return vocabulary.teams.find((team) => team.id === id)?.name ?? null;
      case 'user':
        return vocabulary.users.find((user) => user.id === id)?.displayName ?? null;
    }
  };
}

/** When the workflow fires. The one trigger carrying a parameter reads it out. */
export function describeTrigger(trigger: WorkflowTrigger, content: Content): string {
  const copy = content.workflows;

  switch (trigger.type) {
    case 'ticket_created':
      return copy.summaryTriggerCreated;
    case 'ticket_status_changed':
      return copy.summaryTriggerStatusChanged;
    case 'ticket_assigned':
      return copy.summaryTriggerAssigned;
    case 'ticket_sla_breached':
      return copy.summaryTriggerSlaBreached;
    case 'ticket_unresolved_for':
      return copy.summaryTriggerUnresolvedFor(formatMinutes(trigger.minutes, content));
  }
}

/**
 * One condition as a clause of "and only when …".
 *
 * A tag, team or user the workflow names may have been deleted since it was
 * written. That shows as "a deleted item" rather than as a raw UUID or a silently
 * dropped clause: the workflow really does still reference it, and that is the
 * whole point of `exists: false` reaching the console at all.
 */
export function describeCondition(
  condition: WorkflowCondition,
  names: ReferenceLookup,
  content: Content,
): string {
  const copy = content.workflows;

  switch (condition.type) {
    case 'ticket_status': {
      const values = formatAlternatives(
        condition.values.map((status) => content.ticketStatuses[status]),
        content,
      );

      return condition.operator === 'in'
        ? copy.summaryStatusIn(values)
        : copy.summaryStatusNotIn(values);
    }

    case 'ticket_priority': {
      const values = formatAlternatives(
        condition.values.map((priority) => content.ticketPriorities[priority]),
        content,
      );

      return condition.operator === 'in'
        ? copy.summaryPriorityIn(values)
        : copy.summaryPriorityNotIn(values);
    }

    case 'ticket_assignment':
      return describeAssignment(condition, names, content);

    case 'ticket_tag':
      return describeTagMatch(
        condition.match,
        formatTagNames(condition.tagIds, names, content),
        content,
        'ticket',
      );

    case 'contact_tag':
      return describeTagMatch(
        condition.match,
        formatTagNames(condition.tagIds, names, content),
        content,
        'contact',
      );

    case 'ticket_age': {
      const duration = formatMinutes(condition.minutes, content);

      return condition.operator === 'gte'
        ? copy.summaryAgeAtLeast(duration)
        : copy.summaryAgeAtMost(duration);
    }

    case 'business_hours':
      return condition.within ? copy.summaryWithinHours : copy.summaryOutsideHours;
  }
}

/** One action as an instruction: "tag it escalated", "notify the supervisors". */
export function describeAction(
  action: WorkflowAction,
  names: ReferenceLookup,
  content: Content,
): string {
  const copy = content.workflows;

  switch (action.type) {
    case 'add_ticket_tag':
      return copy.summaryAddTag(names('tag', action.tagId) ?? copy.unknownReference);

    case 'reassign':
      return copy.summaryReassign(describeAssignee(action.target, names, content));

    case 'notify': {
      const audience = describeNotifyAudience(action, names, content);

      return action.message === null
        ? copy.summaryNotify(audience)
        : copy.summaryNotifyWithMessage(audience, action.message);
    }

    case 'set_status':
      return copy.summarySetStatus(content.ticketStatuses[action.status]);

    case 'set_priority':
      return copy.summarySetPriority(content.ticketPriorities[action.priority]);
  }
}

/** The references a workflow names that no longer resolve, as readable labels. */
export function describeBrokenReferences(
  references: readonly WorkflowReference[],
  content: Content,
): readonly string[] {
  const copy = content.workflows;

  return references
    .filter((reference) => !reference.exists)
    .map((reference) => copy.referenceKinds[reference.kind]);
}

function describeAssignment(
  condition: Extract<WorkflowCondition, { type: 'ticket_assignment' }>,
  names: ReferenceLookup,
  content: Content,
): string {
  const copy = content.workflows;

  switch (condition.state) {
    case 'unassigned':
      return copy.summaryUnassigned;

    case 'assigned_to_user':
      return condition.userId === null
        ? copy.summaryAssignedToAnyone
        : copy.summaryAssignedToUser(userPhrase(names, condition.userId, content));

    case 'assigned_to_team':
      return condition.teamId === null
        ? copy.summaryAssignedToAnyTeam
        : copy.summaryAssignedToTeam(teamPhrase(names, condition.teamId, content));
  }
}

function describeAssignee(
  target: Extract<WorkflowAction, { type: 'reassign' }>['target'],
  names: ReferenceLookup,
  content: Content,
): string {
  return target.kind === 'team'
    ? teamPhrase(names, target.teamId, content)
    : userPhrase(names, target.userId, content);
}

/**
 * A reference as the phrase it occupies in a sentence, with a fallback per kind.
 *
 * One fallback for all three would read wrong somewhere: "notify a deleted item"
 * is not English, and "assigned to the a deleted item team" is worse. Naming the
 * kind also tells the supervisor which picker to go and fix.
 */
function teamPhrase(names: ReferenceLookup, teamId: string, content: Content): string {
  const name = names('team', teamId);

  return name === null ? content.workflows.unknownTeam : content.workflows.targetTeamName(name);
}

function userPhrase(names: ReferenceLookup, userId: string, content: Content): string {
  return names('user', userId) ?? content.workflows.unknownUser;
}

function describeNotifyAudience(
  action: Extract<WorkflowAction, { type: 'notify' }>,
  names: ReferenceLookup,
  content: Content,
): string {
  const copy = content.workflows;

  switch (workflowNotifyAudienceTarget(action.audience)) {
    case 'user':
      return userPhrase(names, action.userId ?? '', content);
    case 'team':
      return teamPhrase(names, action.teamId ?? '', content);
    case null:
      return copy.notifyAudiences.supervisors;
  }
}

function describeTagMatch(
  match: WorkflowMatchOperator,
  tags: string,
  content: Content,
  subject: 'ticket' | 'contact',
): string {
  const copy = content.workflows;

  if (subject === 'ticket') {
    return match === 'none' ? copy.summaryTicketNotTagged(tags) : copy.summaryTicketTagged(tags);
  }

  return match === 'none' ? copy.summaryContactNotTagged(tags) : copy.summaryContactTagged(tags);
}

function formatTagNames(
  tagIds: readonly string[],
  names: ReferenceLookup,
  content: Content,
): string {
  return formatAlternatives(
    tagIds.map((tagId) => names('tag', tagId) ?? content.workflows.unknownReference),
    content,
  );
}

/**
 * `Intl.ListFormat` rather than joining on a comma. `all` and `none` are both
 * "a, b and c" — "not tagged a and b" is what `none` means — while `any` is
 * "a, b or c", and getting that difference right is what the browser already
 * knows how to do. The locale comes from the content module, so server and
 * client format identically.
 */
function formatAlternatives(values: readonly string[], content: Content): string {
  return new Intl.ListFormat(content.locale, { style: 'long', type: 'disjunction' }).format(values);
}
