import type { TicketPriority, TicketStatus, WorkflowCondition } from '@whatsappcrm/contracts';

/**
 * Everything a condition can read about one ticket, resolved once per claimed
 * run and then compared in memory — `routing-facts.ts`' shape, for 0007's
 * reasons.
 *
 * Every source that can be absent is nullable in the same way and for the same
 * reason. 0007's rule, carried unchanged into 0009: **a condition with no data
 * to read is false; it never throws and never matches.** So "there is no
 * contact" and "this tenant never configured business hours" are represented as
 * an absent fact rather than as an exception or a default, and the evaluator has
 * one shape to handle instead of two special cases.
 */
export interface WorkflowFacts {
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly assignedUserId: string | null;
  readonly assignedTeamId: string | null;
  /**
   * Minutes since `tickets.created_at`, measured against **Postgres `now()`**
   * rather than a node clock — the same rule the SLA sweep follows, so skew
   * between API instances cannot make a threshold true early.
   */
  readonly ageMinutes: number;
  /** Tags on the ticket (`ticket_tags`). Never null: a ticket always exists. */
  readonly ticketTagIds: ReadonlySet<string>;
  /** Tags on the ticket's contact. **Null when the ticket has no contact.** */
  readonly contactTagIds: ReadonlySet<string> | null;
  /**
   * Whether *now* is inside the tenant's opening hours.
   *
   * **Null is not `false`.** It means the question could not be answered — the
   * tenant has no `business_hours` configured, or the column holds something
   * that is not the published shape — and the condition then evaluates false
   * whichever way `within` is set. Collapsing this into a boolean would make
   * "out of hours, escalate" fire on every ticket for a tenant that never
   * configured anything.
   */
  readonly withinBusinessHours: boolean | null;
}

/**
 * Which of the optional sources a condition set actually reads, so the fact
 * sheet can skip the queries for the rest.
 *
 * 0009's access-patterns table calls this out by name: the fact sheet is read
 * **lazily**, so a workflow whose conditions are all `ticket_status` reads the
 * ticket row and nothing else. Computed from the whole condition set at once
 * rather than per condition, because the reads happen once per run.
 */
export interface WorkflowFactsNeeded {
  readonly ticketTags: boolean;
  readonly contactTags: boolean;
  readonly businessHours: boolean;
}

export function factsNeededBy(conditions: readonly WorkflowCondition[]): WorkflowFactsNeeded {
  const types = new Set(conditions.map((condition) => condition.type));

  return {
    ticketTags: types.has('ticket_tag'),
    contactTags: types.has('contact_tag'),
    businessHours: types.has('business_hours'),
  };
}

/** The union of what several workflows need, for one shared read per job. */
export function mergeFactsNeeded(needed: readonly WorkflowFactsNeeded[]): WorkflowFactsNeeded {
  return {
    ticketTags: needed.some((one) => one.ticketTags),
    contactTags: needed.some((one) => one.contactTags),
    businessHours: needed.some((one) => one.businessHours),
  };
}
