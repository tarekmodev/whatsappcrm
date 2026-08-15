import type { RoutingCondition } from '@whatsappcrm/contracts';

/**
 * Everything a rule can read about one ticket, resolved once before evaluation
 * and then compared in memory.
 *
 * Four sources, and every one of them is nullable in the same way and for the
 * same reason. 0007's rule is that **a condition with no data to read is false;
 * it never throws and never matches** — so "there is no contact", "the ticket
 * was created by hand and has no message" and "this tenant never configured
 * business hours" are all represented as an absent fact rather than as an
 * exception or a default, and the evaluator has one shape to handle instead of
 * three special cases.
 *
 * Resolved once per ticket, not once per rule, and only the sources the tenant's
 * rules actually name (0007, access patterns): a tenant whose rules are all
 * `business_hours` reads neither the contact nor the message.
 */
export interface RoutingFacts {
  /**
   * `messages.body` of the message that opened the ticket — the caption on a
   * media message, when there is one. Null for a manual ticket, for a media
   * message with no caption, and for a message that has since been deleted.
   */
  readonly messageBody: string | null;
  /** The ticket contact's tags. Null when the ticket has no contact. */
  readonly tagIds: ReadonlySet<string> | null;
  /**
   * The ticket contact's `custom_fields`.
   *
   * **`{}` is not `null`.** Null means there is no contact to read — no contact
   * on the ticket, or none visible in this tenant — and every
   * `contact_attribute` condition is false against it. An empty object means the
   * contact is there with nothing set, which is what `is_not_set` is *true* of.
   * The column is nullable and a contact auto-created from a first inbound
   * message leaves it null, so collapsing the two would stop "this field is not
   * set" firing for exactly the new customers it is written for.
   */
  readonly customFields: Readonly<Record<string, string | null>> | null;
  /**
   * Whether the ticket was created inside the tenant's opening hours.
   *
   * **Null is not `false`.** It means the question could not be answered — the
   * tenant has no `business_hours` configured, or the column holds something
   * that is not the published shape — and 0007 decision 3 refuses to guess in
   * that case: the condition evaluates false whichever way `within` is set, so
   * the rule does not match and evaluation continues. Collapsing this into a
   * boolean would make "out of hours, route to the on-call team" fire on every
   * ticket for a tenant that never configured anything.
   */
  readonly withinBusinessHours: boolean | null;
}

/**
 * Which of the four sources a rule set actually reads, so the engine can skip
 * the queries for the rest.
 *
 * Computed from the whole active set at once rather than per rule: the reads
 * happen once per ticket, so what matters is whether *any* rule names a type.
 */
export interface RoutingFactsNeeded {
  readonly messageBody: boolean;
  readonly tags: boolean;
  readonly customFields: boolean;
  readonly businessHours: boolean;
}

export function factsNeededBy(
  ruleConditions: readonly (readonly RoutingCondition[])[],
): RoutingFactsNeeded {
  const types = new Set(ruleConditions.flat().map((condition) => condition.type));

  return {
    messageBody: types.has('keyword'),
    tags: types.has('tag'),
    customFields: types.has('contact_attribute'),
    businessHours: types.has('business_hours'),
  };
}
