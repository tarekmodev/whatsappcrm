import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/**
 * Ticket routing: the condition-rule grammar, the queue trigger, and the seam
 * between the two halves of it.
 *
 * Full reasoning, alternatives and failure modes across two documents:
 * `docs/architecture/0007-routing-rules-and-assignment-fallback.md` (TAR-279)
 * owns the pipeline and the seam; `0008-assignment-rotation-and-workload.md`
 * (TAR-271) owns what sits behind the seam. Read 0007 first — where they could
 * disagree, 0007 wins.
 *
 * **Why one file holds two stories' contracts.** 0007 published its interfaces
 * as a document and landed no code, so this file was still unwritten when both
 * TAR-273 (rotation) and TAR-288 (the rule engine) needed it. 0008 resolves that
 * explicitly: whichever lands first writes both halves at once, rather than
 * creating the file and then widening it. TAR-273 landed first, so everything
 * below is 0007's text except {@link ASSIGNMENT_POLICY}, which is 0008's.
 *
 * `packages/contracts` is the only thing both sides of every seam here import:
 * `AssignmentModule` holds the rule engine and the rotation resolver, and the
 * two are developed in parallel against these shapes rather than against each
 * other's classes.
 */

// ---------------------------------------------------------------------------
// Limits and policy
// ---------------------------------------------------------------------------

/**
 * Published as a constant so the API, the console and the ADR cannot drift.
 *
 * None of these is a limit a real tenant meets — a supervisor maintaining 200
 * ordered rules has outgrown a rule list and wants TAR-27's automation engine.
 * They exist because the evaluation cost of one ticket is
 * `rules x conditions x values` string comparisons on a shared worker, and
 * because the list endpoint returns the whole set.
 */
export const ROUTING_RULE_LIMITS = {
  /** Active and inactive together. The engine loads the active set whole. */
  rulesPerTenant: 200,
  /** Conditions in one rule, all of which must hold. */
  conditionsPerRule: 10,
  /** Values in one `keyword` condition, and tag ids in one `tag` condition. */
  valuesPerCondition: 25,
  /** Characters in one keyword value. */
  keywordLength: 80,
} as const;

/**
 * The numbers rotation runs on (0008 decisions 1 and 4), on `AUTH_POLICY`'s
 * precedent: three consumers have to agree on them — the API enforces them, the
 * console renders copy from them, and QA asserts against them — and three
 * literals in three packages drift.
 *
 * The two bounds are also `users_max_concurrent_tickets_range` and
 * `tenant_settings_default_max_concurrent_tickets_range` in
 * `20260813140000_assignment_workload_and_routing_state`. The constant and the
 * CHECK constraints have to move together.
 */
export const ASSIGNMENT_POLICY = {
  /**
   * The cap an agent inherits when `tenant_settings` has no row yet. Five is a
   * defensible starting value, **not a measured one**.
   */
  defaultMaxConcurrentTickets: 5,
  /**
   * The floor is 1, not 0: "route nothing to me" is what
   * `availability = 'away'` already means, and a second way to say it is a
   * second thing to keep in step.
   */
  minMaxConcurrentTickets: 1,
  /**
   * Arbitrary but not pointless — it is what stops a fat-fingered 50000 from
   * turning the cap off without anybody noticing.
   */
  maxMaxConcurrentTickets: 1000,
  /**
   * How stale `users.last_seen_at` may be and still count as present.
   *
   * Longer than `AUTH_POLICY.sessionSlideThrottleMs` (5 min), so a working agent
   * can never age out between two writes of their own session; short enough that
   * a closed laptop stops receiving work inside one coffee break. It is the one
   * product-visible number 0008 invents, and it is one value in one place
   * precisely so it can be changed on evidence — see 0008 risk 1.
   */
  presenceWindowMs: 15 * 60 * 1000,
} as const;

export const MaxConcurrentTicketsSchema = z
  .int()
  .min(ASSIGNMENT_POLICY.minMaxConcurrentTickets)
  .max(ASSIGNMENT_POLICY.maxMaxConcurrentTickets);

// ---------------------------------------------------------------------------
// Transport — the routing trigger
// ---------------------------------------------------------------------------

/** BullMQ queue owned by `AssignmentModule`. */
export const ASSIGNMENT_QUEUE = 'assignment';

/**
 * The job `TicketsModule` enqueues after a ticket-creating transaction commits.
 * Delivery is at-least-once; the handler is idempotent by compare-and-set, so a
 * redelivery finds the ticket assigned and skips.
 */
export const ASSIGNMENT_ROUTE_JOB = 'assignment.route-ticket';

/**
 * Five fields and no more. Everything else is reachable from `ticketId`, and the
 * consumer re-reads all of it in tenant scope regardless, because a queue
 * payload is unauthenticated input.
 *
 * `messageId` is carried rather than derived so that a `keyword` condition
 * matches the message that actually opened the ticket, not whichever message is
 * newest by the time the worker runs.
 */
export const TicketRoutingTriggerSchema = z.object({
  tenantId: IdSchema,
  ticketId: IdSchema,
  /** Null for TAR-25's contact-less ticket. `tag` and `contact_attribute` are then false. */
  contactId: IdSchema.nullable(),
  /** Null for a ticket created by hand (TAR-25). `keyword` conditions are then false. */
  messageId: IdSchema.nullable(),
  createdAt: TimestampSchema,
});

export type TicketRoutingTrigger = z.infer<typeof TicketRoutingTriggerSchema>;

/**
 * Stable BullMQ `jobId`, so a duplicate enqueue collapses while the first is
 * still queued. An optimisation, not the correctness mechanism — that is the
 * compare-and-set on the assignment write.
 *
 * Hyphens, never a colon. BullMQ reserves `:` for its own Redis key structure
 * and rejects a custom id containing one, and `QueueService.enqueue` logs that
 * rejection rather than throwing — so a violation stops routing silently
 * (TAR-249, and the rule `ticket-linking.ts` already follows).
 */
export function assignmentRouteJobId(trigger: TicketRoutingTrigger): string {
  return `assignment-route-${trigger.tenantId}-${trigger.ticketId}`;
}

// ---------------------------------------------------------------------------
// The rule grammar
// ---------------------------------------------------------------------------

/**
 * The three capabilities TAR-24 commits to at launch. Keyword and tag are split
 * into two types rather than blended into one because they read different data —
 * the message body versus the contact's tags — and a single type carrying both
 * would need a mode discriminator anyway.
 *
 * **A condition that has no data to read is false.** It never throws and never
 * matches, so a manual ticket with no message still routes on its other
 * conditions and still reaches rotation.
 */
export const ROUTING_CONDITION_TYPES = [
  'keyword',
  'tag',
  'business_hours',
  'contact_attribute',
] as const;
export const RoutingConditionTypeSchema = z.enum(ROUTING_CONDITION_TYPES);

/**
 * Matches `messages.body`, which is also the caption on a media message — so
 * "if the customer sends a photo captioned 'invoice'" works without a fifth
 * condition type.
 *
 * Matching is substring, case-insensitive, on the trimmed value; it is not
 * word-boundary aware, so `bill` matches `billing`. That is what a box labelled
 * "contains" means to the person writing the rule, and the alternative —
 * tenant-authored regular expressions — is a denial-of-service surface pointed
 * at our own worker.
 */
export const KeywordConditionSchema = z.object({
  type: z.literal('keyword'),
  /** `any` — at least one value appears. `all` — every value appears. */
  match: z.enum(['any', 'all']),
  values: z
    .array(z.string().min(1).max(ROUTING_RULE_LIMITS.keywordLength))
    .min(1)
    .max(ROUTING_RULE_LIMITS.valuesPerCondition),
});

export const TagConditionSchema = z.object({
  type: z.literal('tag'),
  match: z.enum(['any', 'all']),
  tagIds: z.array(IdSchema).min(1).max(ROUTING_RULE_LIMITS.valuesPerCondition),
});

/**
 * Reads `tenant_settings.business_hours` and `.timezone`.
 *
 * **It refuses to guess.** When the tenant has configured no hours the condition
 * evaluates false whichever way `within` is set, so the rule does not match and
 * evaluation continues. Treating an unconfigured tenant as always open, or
 * always closed, makes one of the two natural rules fire on every ticket.
 */
export const BusinessHoursConditionSchema = z.object({
  type: z.literal('business_hours'),
  /** `true` — inside the tenant's business hours. `false` — outside them. */
  within: z.boolean(),
});

export const CONTACT_ATTRIBUTE_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'is_set',
  'is_not_set',
] as const;
export const ContactAttributeOperatorSchema = z.enum(CONTACT_ATTRIBUTE_OPERATORS);

/**
 * Reads `contacts.custom_fields`, and **only** custom fields — not built-in
 * contact columns. The key must name a row in `custom_field_defs`, which gives
 * the console a dropdown to populate and the API something to validate against;
 * a free-text attribute path would be a typo that silently never matches.
 */
export const ContactAttributeConditionSchema = z
  .object({
    type: z.literal('contact_attribute'),
    /** Must name a `custom_field_defs.key` in this tenant. */
    key: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_]*$/),
    operator: ContactAttributeOperatorSchema,
    /** Null exactly when the operator is `is_set` or `is_not_set`. */
    value: z.string().max(200).nullable(),
  })
  .refine((c) => (c.operator === 'is_set' || c.operator === 'is_not_set') === (c.value === null), {
    message: '`value` is required for every operator except `is_set` and `is_not_set`',
  });

export const RoutingConditionSchema = z.discriminatedUnion('type', [
  KeywordConditionSchema,
  TagConditionSchema,
  BusinessHoursConditionSchema,
  ContactAttributeConditionSchema,
]);

/**
 * Exactly one target. Both, or neither, is `validation_failed`.
 *
 * A discriminated union on the wire and two columns in the database: the union
 * is what makes "exactly one" unrepresentable-if-wrong for the console, and the
 * columns are what give the target a foreign key, which JSONB cannot.
 */
export const RoutingTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('team'), teamId: IdSchema }),
  z.object({ kind: z.literal('user'), userId: IdSchema }),
]);

export const AssignmentRuleResponseSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  /** Ascending. Ties break on `id`, which is creation order. */
  position: z.int().min(0),
  isActive: z.boolean(),
  conditions: z.array(RoutingConditionSchema).min(1).max(ROUTING_RULE_LIMITS.conditionsPerRule),
  /**
   * Null only on a rule deactivated by the removal of its target user
   * (`users.service.ts`). A rule cannot be re-enabled until it has one again.
   */
  target: RoutingTargetSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const AssignmentRuleCreateInputSchema = z.object({
  name: z.string().min(1).max(80),
  conditions: z.array(RoutingConditionSchema).min(1).max(ROUTING_RULE_LIMITS.conditionsPerRule),
  target: RoutingTargetSchema,
  /** Omitted, the rule is appended last. */
  position: z.int().min(0).optional(),
  isActive: z.boolean().default(true),
});

export const AssignmentRuleUpdateInputSchema = AssignmentRuleCreateInputSchema.partial();

export const AssignmentRuleReorderInputSchema = z.object({
  /** The tenant's complete rule set, in the order it should evaluate. */
  ruleIds: z.array(IdSchema).max(ROUTING_RULE_LIMITS.rulesPerTenant),
});

/**
 * Keeps `CursorPage`'s shape with `nextCursor` fixed at `null`, so a generic
 * list client works against it unchanged and pagination stays addable without a
 * breaking change. The set is bounded by `ROUTING_RULE_LIMITS.rulesPerTenant`,
 * which the server enforces on create — the one case where "few" is a promise
 * the API can actually keep.
 */
export const AssignmentRuleListResponseSchema = z.object({
  items: z.array(AssignmentRuleResponseSchema),
  nextCursor: z.null(),
});

export type RoutingConditionType = z.infer<typeof RoutingConditionTypeSchema>;
export type ContactAttributeOperator = z.infer<typeof ContactAttributeOperatorSchema>;
export type RoutingCondition = z.infer<typeof RoutingConditionSchema>;
export type RoutingTarget = z.infer<typeof RoutingTargetSchema>;
export type AssignmentRuleResponse = z.infer<typeof AssignmentRuleResponseSchema>;
export type AssignmentRuleCreateInput = z.infer<typeof AssignmentRuleCreateInputSchema>;
export type AssignmentRuleUpdateInput = z.infer<typeof AssignmentRuleUpdateInputSchema>;
export type AssignmentRuleReorderInput = z.infer<typeof AssignmentRuleReorderInputSchema>;
export type AssignmentRuleListResponse = z.infer<typeof AssignmentRuleListResponseSchema>;

// ---------------------------------------------------------------------------
// The fallback seam
// ---------------------------------------------------------------------------

export const FALLBACK_ASSIGNMENT_OUTCOMES = ['assigned', 'no_eligible_agent'] as const;
export const FallbackAssignmentOutcomeSchema = z.enum(FALLBACK_ASSIGNMENT_OUTCOMES);

/**
 * Why rotation had nobody. Three values rather than two, because "nobody is
 * online" and "nobody was ever put in this team" need different people to act,
 * and collapsing them sends a supervisor hunting for absent colleagues who were
 * never configured.
 *
 * This is also `ticket_routing_deferred_reason` in Postgres, verbatim and in
 * order (TAR-272) — one vocabulary across the decision object, the column and
 * the `assignment_deferred` event, rather than three that have to be mapped.
 *
 * Precedence when the truth is mixed, first match wins:
 *
 *   1. any present, available candidate exists  → `all_at_capacity`
 *   2. any active user is in the scope          → `none_available`
 *   3. otherwise                                → `no_candidate_pool`
 *
 * `all_at_capacity` wins the first tie because it is the state that resolves
 * itself as tickets close, and therefore the more useful thing to tell somebody
 * staring at the queue.
 */
export const FALLBACK_ASSIGNMENT_REASONS = [
  /** Every candidate is at their configured concurrent-ticket limit. */
  'all_at_capacity',
  /** Every candidate is `away`, `offline`, or has not been seen recently. */
  'none_available',
  /** There was nobody to consider: no team members, or no agents in the tenant. */
  'no_candidate_pool',
] as const;
export const FallbackAssignmentReasonSchema = z.enum(FALLBACK_ASSIGNMENT_REASONS);

export const FallbackAssignmentRequestSchema = z.object({
  tenantId: IdSchema,
  ticketId: IdSchema,
  contactId: IdSchema.nullable(),
  /**
   * The team to rotate within, when the caller has one in mind — its members,
   * whatever their role. Null is the tenant pool, which is `role = 'agent'`
   * only: a supervisor holds every agent permission, so without that restriction
   * every tenant's supervisor is silently placed in the rotation.
   *
   * Null is also the only case TAR-24 uses today. The field is here so that "a
   * team rule selects the team, rotation picks the person" (0007 decision 4's
   * rejected option) needs no signature change.
   */
  teamId: IdSchema.nullable(),
});

export const FallbackAssignmentDecisionSchema = z.object({
  outcome: FallbackAssignmentOutcomeSchema,
  /** Non-null exactly when `outcome` is `assigned`. */
  userId: IdSchema.nullable(),
  /** The team the rotation was taken from, when there was one. */
  teamId: IdSchema.nullable(),
  /** Non-null exactly when `outcome` is `no_eligible_agent`. */
  reason: FallbackAssignmentReasonSchema.nullable(),
});

export type FallbackAssignmentOutcome = z.infer<typeof FallbackAssignmentOutcomeSchema>;
export type FallbackAssignmentReason = z.infer<typeof FallbackAssignmentReasonSchema>;
export type FallbackAssignmentRequest = z.infer<typeof FallbackAssignmentRequestSchema>;
export type FallbackAssignmentDecision = z.infer<typeof FallbackAssignmentDecisionSchema>;

/**
 * What the rule engine calls when no rule matched.
 *
 * Three obligations, and they are the whole contract:
 *
 *   * **It decides; the caller writes.** Rotation returns who it picked and does
 *     not touch `tickets`. The assignment write stays in one place, because it
 *     is a compare-and-set that also appends the ticket event, and because it is
 *     the only place tenant scope has to be right.
 *   * **`no_eligible_agent` names a reason.** A bare `null` would collapse an
 *     operational state a supervisor must see and can act on with "there was
 *     nobody to consider".
 *   * **Infrastructure failure throws; it is never an outcome.** A decision means
 *     rotation reached an answer. A database error or a missing tenant context
 *     propagates, the job fails, and BullMQ's retry policy decides what happens
 *     next.
 *
 * Implemented by TAR-273 as `RotationFallbackResolver`, in `AssignmentModule`.
 */
export interface FallbackAssignmentResolver {
  resolveFallbackAssignment(
    request: FallbackAssignmentRequest,
  ): Promise<FallbackAssignmentDecision>;
}

/**
 * Nest injection token. `AssignmentModule` provides it and the rule engine
 * consumes it — an injected token inside one module, so the two halves can be
 * built and tested in parallel, not a layering boundary.
 */
export const FALLBACK_ASSIGNMENT_RESOLVER = Symbol.for('whatsappcrm.FallbackAssignmentResolver');

// ---------------------------------------------------------------------------
// The routing result
// ---------------------------------------------------------------------------

export const TICKET_ROUTING_OUTCOMES = [
  'routed',
  'fallback_assigned',
  'deferred',
  'skipped',
] as const;
export const TicketRoutingOutcomeSchema = z.enum(TICKET_ROUTING_OUTCOMES);

export const TICKET_ROUTING_SKIP_REASONS = ['already_assigned', 'ticket_not_active'] as const;
export const TicketRoutingSkipReasonSchema = z.enum(TICKET_ROUTING_SKIP_REASONS);

/**
 * | Situation                                        | `outcome`           | `ruleId` | `reason`            |
 * | ------------------------------------------------ | ------------------- | -------- | ------------------- |
 * | A rule matched and its target was usable         | `routed`            | the rule | `null`              |
 * | No rule matched; rotation picked someone         | `fallback_assigned` | `null`   | `null`              |
 * | No rule matched; rotation had nobody             | `deferred`          | `null`   | the fallback reason |
 * | The ticket was already assigned when the job ran | `skipped`           | `null`   | `already_assigned`  |
 * | The ticket is `resolved` or `closed`             | `skipped`           | `null`   | `ticket_not_active` |
 */
export const TicketRoutingResultSchema = z.object({
  outcome: TicketRoutingOutcomeSchema,
  /** The rule that matched. Null on every outcome but `routed`. */
  ruleId: IdSchema.nullable(),
  assignedUserId: IdSchema.nullable(),
  assignedTeamId: IdSchema.nullable(),
  /** A `FallbackAssignmentReason` on `deferred`, a skip reason on `skipped`. */
  reason: z.string().nullable(),
});

export type TicketRoutingOutcome = z.infer<typeof TicketRoutingOutcomeSchema>;
export type TicketRoutingSkipReason = z.infer<typeof TicketRoutingSkipReasonSchema>;
export type TicketRoutingResult = z.infer<typeof TicketRoutingResultSchema>;

/**
 * The rule engine's own surface — routing one ticket end to end. Implemented by
 * TAR-288; declared here so `TicketsModule`'s enqueue and the queue runner name
 * a contract rather than a class.
 */
export interface TicketRouter {
  routeTicket(trigger: TicketRoutingTrigger): Promise<TicketRoutingResult>;
}

export const TICKET_ROUTER = Symbol.for('whatsappcrm.TicketRouter');
