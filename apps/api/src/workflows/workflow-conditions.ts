import type {
  TicketAgeCondition,
  TicketAssignmentCondition,
  TicketPriorityCondition,
  TicketStatusCondition,
  WorkflowCondition,
  WorkflowConditionUnreadableReason,
  WorkflowMatchOperator,
  WorkflowSetOperator,
} from '@whatsappcrm/contracts';
import type { WorkflowFacts } from './workflow-facts';

/**
 * The condition grammar, evaluated.
 *
 * Pure functions over `WorkflowFacts` — no database, no tenant context, no
 * framework, no injected anything. That is what makes the table of cases in
 * `workflow-conditions.spec.ts` a readable specification rather than a fixture
 * exercise, and it is why the engine resolves its facts first and compares
 * second. It is also `WorkflowConditionEvaluator` in 0009's component table:
 * "pure evaluation of a condition set against a fact sheet. No database."
 *
 * Three properties hold for every branch below, all three from 0009 decision 4:
 *
 *   * **Conditions inside a workflow combine with AND.** There is no OR, no
 *     rule-level toggle and no nested tree; a supervisor wanting OR writes two
 *     workflows.
 *   * **An empty condition set matches**, unlike 0007's rule list. "Every time
 *     this trigger fires, do this" is a legitimate automation and cannot swallow
 *     anything, because every other workflow still runs.
 *   * **A condition with no data to read is false.** It never throws, and it
 *     never matches — including a `business_hours` condition asking
 *     `within: false` of a tenant that never configured hours, and a
 *     `contact_tag` condition on a ticket with no contact.
 */

/** One condition's verdict, and why it could not be read when that is the answer. */
export interface ConditionVerdict {
  readonly held: boolean;
  /**
   * Non-null only when the condition had **no data to read** — which is a
   * different fact from "it read the data and did not match", and the dry run
   * renders it differently. A condition that simply did not hold carries null.
   */
  readonly unreadable: WorkflowConditionUnreadableReason | null;
}

/** Every condition holds. An empty list matches — see the docblock above. */
export function workflowMatches(
  conditions: readonly WorkflowCondition[],
  facts: WorkflowFacts,
): boolean {
  return conditions.every((condition) => evaluateCondition(condition, facts).held);
}

/** One verdict per condition, in order — what the dry run publishes. */
export function evaluateConditions(
  conditions: readonly WorkflowCondition[],
  facts: WorkflowFacts,
): ConditionVerdict[] {
  return conditions.map((condition) => evaluateCondition(condition, facts));
}

export function evaluateCondition(
  condition: WorkflowCondition,
  facts: WorkflowFacts,
): ConditionVerdict {
  switch (condition.type) {
    case 'ticket_status':
      return held(statusMatches(condition, facts.status));
    case 'ticket_priority':
      return held(priorityMatches(condition, facts.priority));
    case 'ticket_assignment':
      return held(assignmentMatches(condition, facts));
    case 'ticket_tag':
      return held(tagMatches(condition.match, condition.tagIds, facts.ticketTagIds));
    case 'contact_tag':
      // Null is "there is no contact", not "the contact has no tags" — and the
      // difference is what `no_contact` reports. An empty set is a contact with
      // nothing on it, which `none` is legitimately *true* of.
      return facts.contactTagIds === null
        ? { held: false, unreadable: 'no_contact' }
        : held(tagMatches(condition.match, condition.tagIds, facts.contactTagIds));
    case 'ticket_age':
      return held(ageMatches(condition, facts.ageMinutes));
    case 'business_hours':
      // `withinBusinessHours === null` is "unanswerable", and it is false for
      // both settings of `within` rather than being the opposite of `true`.
      return facts.withinBusinessHours === null
        ? { held: false, unreadable: 'business_hours_unconfigured' }
        : held(facts.withinBusinessHours === condition.within);
  }
}

function held(value: boolean): ConditionVerdict {
  return { held: value, unreadable: null };
}

function statusMatches(condition: TicketStatusCondition, status: string): boolean {
  return inSet(condition.operator, condition.values, status);
}

function priorityMatches(condition: TicketPriorityCondition, priority: string): boolean {
  return inSet(condition.operator, condition.values, priority);
}

/**
 * The three assignment states, each optionally narrowed to one team or one user.
 *
 * `teamId`/`userId` null means "any", so `assigned_to_user` with no `userId` is
 * "somebody holds this", which is the common case a supervisor writes. The
 * schema already refuses the combinations that would contradict the state —
 * `unassigned` with a target, `assigned_to_user` with a `teamId` — so this
 * function never has to consider them.
 *
 * A ticket assigned to a user *and* a team satisfies both `assigned_to_user` and
 * `assigned_to_team`, deliberately: both statements are true of it, and a rule
 * asking "is anybody on this" should not turn false because a team is named too.
 */
function assignmentMatches(condition: TicketAssignmentCondition, facts: WorkflowFacts): boolean {
  switch (condition.state) {
    case 'unassigned':
      return facts.assignedUserId === null && facts.assignedTeamId === null;
    case 'assigned_to_user':
      return (
        facts.assignedUserId !== null &&
        (condition.userId === null || facts.assignedUserId === condition.userId)
      );
    case 'assigned_to_team':
      return (
        facts.assignedTeamId !== null &&
        (condition.teamId === null || facts.assignedTeamId === condition.teamId)
      );
  }
}

/**
 * `any` — at least one of the named tags is on it. `all` — every one is.
 * `none` — not one is.
 *
 * `none` exists here and does not in 0007, and it is the one place this grammar
 * is wider than that one. A routing rule asking "does the contact NOT have this
 * tag" is expressible as a rule placed later in the ordered list; a workflow
 * list has no first-match ordering to express it with, so the negation has to be
 * in the grammar. That is decision 4's cost, paid here.
 */
function tagMatches(
  match: WorkflowMatchOperator,
  tagIds: readonly string[],
  held: ReadonlySet<string>,
): boolean {
  const carries = (tagId: string): boolean => held.has(tagId);

  switch (match) {
    case 'any':
      return tagIds.some(carries);
    case 'all':
      return tagIds.every(carries);
    case 'none':
      return !tagIds.some(carries);
  }
}

/**
 * `gte` — the ticket is at least this old. `lte` — it is at most this old.
 *
 * Both inclusive, which is what "more than 4 hours" means to the person writing
 * the rule at the boundary and is the only reading under which a threshold of
 * exactly `minutes` ever fires: the sweep's own predicate is
 * `created_at <= now() - interval`, so a ticket arrives here having just reached
 * the bound, never having passed it.
 */
function ageMatches(condition: TicketAgeCondition, ageMinutes: number): boolean {
  return condition.operator === 'gte'
    ? ageMinutes >= condition.minutes
    : ageMinutes <= condition.minutes;
}

function inSet<T extends string>(
  operator: WorkflowSetOperator,
  values: readonly T[],
  value: string,
): boolean {
  const present = values.some((candidate) => candidate === value);

  return operator === 'in' ? present : !present;
}
