import { ROUTING_RULE_LIMITS } from '@whatsappcrm/contracts';

/**
 * The one way `resolveFallbackAssignment` gives up rather than returning a
 * decision.
 *
 * 0007 decision 5 draws the line and it is worth restating: a **decision** means
 * rotation reached an answer, including the answer "nobody was eligible".
 * Everything else throws, the routing job fails, and BullMQ's retry policy
 * decides what happens next. There is deliberately no error for "no eligible
 * agent" — that is a `no_eligible_agent` decision carrying a reason, because a
 * supervisor has to see it.
 *
 * The failures that are not this one are raised elsewhere and pass through
 * untouched: `MissingTenantContextError` and `TenantNotActiveError` come out of
 * `TenantPrisma` (`src/prisma/prisma.errors.ts`), and a database fault is a
 * database fault.
 */

/**
 * The request names a different tenant from the one in scope.
 *
 * **Not retryable, and not a race.** A `FallbackAssignmentRequest` reaches the
 * resolver from a queue payload, which is unauthenticated input; the worker is
 * required to put `job.data.tenantId` in scope before its first statement
 * (0007, rule 3). If the two disagree, either the caller skipped that step or
 * the payload is forged, and both are bugs rather than transient conditions.
 *
 * Nothing here would actually leak if it were ignored — every predicate in the
 * candidate query uses the tenant in scope, and RLS filters on it regardless, so
 * a forged `tenantId` influences no row. It throws anyway: a value that is
 * silently disregarded is a value the next reader will assume is being honoured.
 */
export class FallbackAssignmentTenantMismatchError extends Error {
  constructor(
    readonly requestedTenantId: string,
    readonly scopedTenantId: string,
  ) {
    super(
      `Fallback assignment was requested for tenant ${requestedTenantId} while tenant ` +
        `${scopedTenantId} is in scope. The routing worker must set tenant context from ` +
        'job.data.tenantId before calling the resolver.',
    );
    // `Error` breaks the prototype chain when down-levelled, which would make
    // `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Typed failures the assignment services raise, mapped to error codes in
 * `assignment.http.ts`.
 *
 * Domain errors rather than `ApiException`s from the service layer, on
 * `people.errors.ts`' reasoning: the rule service is driven by the engine's
 * tests and by fixtures as well as by HTTP, and neither of those has a response
 * to put a status on.
 */

export class AssignmentRuleNotFoundError extends Error {
  constructor(readonly ruleId: string) {
    super(`No routing rule ${ruleId} in this tenant.`);
    this.name = 'AssignmentRuleNotFoundError';
  }
}

export class AssignmentRuleNameTakenError extends Error {
  constructor(readonly ruleName: string) {
    // `citext`, so `Billing` collides with `billing` — worth saying, because
    // "Billing already exists" is confusing when you typed "billing".
    super(
      `A routing rule named ${ruleName} already exists in this tenant. Rule names are ` +
        'case-insensitive.',
    );
    this.name = 'AssignmentRuleNameTakenError';
  }
}

/**
 * The cap on rules per tenant, reached on create.
 *
 * `conflict`, not `plan_limit_exceeded` (0007, limits): the cap is a property of
 * the engine — one ticket costs `rules × conditions × values` comparisons on a
 * shared worker — not of the tenant's plan, and answering `402` would send a
 * supervisor to the billing page to fix something money cannot.
 */
export class TooManyAssignmentRulesError extends Error {
  constructor() {
    super(
      `This tenant already has ${ROUTING_RULE_LIMITS.rulesPerTenant} routing rules, which is the ` +
        'maximum. Delete or merge a rule before adding another.',
    );
    this.name = 'TooManyAssignmentRulesError';
  }
}

/**
 * A `target`, or a `contact_attribute` key, naming something that is not in this
 * tenant.
 *
 * `validation_failed` naming the field, never `not_found` (0007, REST surface):
 * row-level security means another tenant's team is simply not visible, so the
 * server genuinely cannot tell it from a team that does not exist — and that
 * indistinguishability is the point. The refusal says which field is wrong,
 * which is what the console needs, and confirms nothing.
 */
export class UnknownRuleReferenceError extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(`${value} is not in this tenant.`);
    this.name = 'UnknownRuleReferenceError';
  }
}

/**
 * `isActive: true` on a rule that has no target.
 *
 * The API half of the CHECK constraint, which is conditional on `is_active`
 * precisely so that `UsersService` can leave a target-less inactive rule behind
 * when a target user is removed. Refusing here means the supervisor is told what
 * is missing instead of being shown a constraint violation.
 */
export class RuleNeedsTargetError extends Error {
  constructor(readonly ruleId: string) {
    super(
      'This rule has no target, which happens when the user it routed to was removed. Name a ' +
        'team or a user before enabling it.',
    );
    this.name = 'RuleNeedsTargetError';
  }
}

/**
 * `reorder` was given something other than the tenant's current rule set.
 *
 * `ruleIds` is the whole set rather than a delta, which buys optimistic
 * concurrency for free: a set that does not match exactly means another
 * supervisor created or deleted a rule since this client loaded the page, and
 * the honest answer is `conflict` rather than a silent partial reorder.
 */
export class RuleSetChangedError extends Error {
  constructor() {
    super(
      'The rule list changed since you loaded it — somebody added or removed a rule. Reload and ' +
        'reorder again.',
    );
    this.name = 'RuleSetChangedError';
  }
}

/**
 * Stored `conditions` that no longer parse against the published grammar.
 *
 * Unreachable through the API, which is the only writer and validates on the way
 * in; it would take a hand-edited row or a grammar change that removed a
 * condition type. Raised rather than swallowed because corrupt routing
 * configuration is something the supervisor has to be told about — the *engine*
 * makes the opposite choice deliberately and skips the rule, because there its
 * job is to not misroute a live ticket.
 */
/**
 * The routing job named a ticket that is not visible in this tenant scope.
 *
 * Retryable, and the realistic cause is benign: the job overtook the transaction
 * that created its ticket. The other cause — a forged or stale payload naming
 * another tenant's ticket — reads nothing under RLS and arrives here too, and
 * failing loudly is the right answer for both.
 */
export class TicketNotVisibleError extends Error {
  constructor(readonly ticketId: string) {
    super(`Ticket ${ticketId} is not visible in this tenant scope.`);
    this.name = 'TicketNotVisibleError';
  }
}

export class MalformedRuleConditionsError extends Error {
  constructor(
    readonly ruleId: string,
    readonly detail: string,
  ) {
    super(`Routing rule ${ruleId} has conditions that do not parse: ${detail}`);
    this.name = 'MalformedRuleConditionsError';
  }
}
