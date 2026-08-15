import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/**
 * Routing rules: the condition grammar a supervisor writes, and the CRUD surface
 * behind it (TAR-24).
 *
 * Fixed by `docs/architecture/0007-routing-rules-and-assignment-fallback.md`.
 * This file is that document's *grammar and DTO* half, transcribed so `apps/api`
 * and `apps/web` validate against one object rather than two readings of a
 * markdown table.
 *
 * 0007 also specifies the queue trigger (`TicketRoutingTrigger`), the routing
 * result (`TicketRoutingResult`) and the `FallbackAssignmentResolver` seam.
 * TAR-289 transcribed only the half `apps/web` consumes and noted the rest was
 * additive; **TAR-273 added it below**, so the file now holds both halves of
 * 0007 as that document intended.
 *
 * One section is not 0007's at all: {@link ASSIGNMENT_POLICY} comes from
 * `docs/architecture/0008-assignment-rotation-and-workload.md` (TAR-271), which
 * fills in what sits *behind* the seam — who is eligible for a ticket nobody's
 * rule claimed, and how loaded they may be. Read 0007 first; where the two could
 * disagree, 0007 wins.
 */

/**
 * Caps the engine enforces, published so the API, the console and 0007 cannot
 * drift. None is a limit a real tenant meets: evaluating one ticket costs
 * `rules × conditions × values` string comparisons on a shared worker, and the
 * list endpoint returns the whole set, so the set has to be bounded.
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
 * The field lengths 0007 writes as literals inside its schemas. Named here so a
 * form's `maxLength` and the schema that refuses the value cannot disagree.
 * Additive to `ROUTING_RULE_LIMITS`, which stays exactly as 0007 published it.
 */
export const ROUTING_RULE_FIELD_LENGTHS = {
  name: 80,
  /** Names a `custom_field_defs.key`, which is capped at the same length. */
  attributeKey: 40,
  attributeValue: 200,
} as const;

export const ROUTING_CONDITION_TYPES = [
  'keyword',
  'tag',
  'business_hours',
  'contact_attribute',
] as const;

export const RoutingConditionTypeSchema = z.enum(ROUTING_CONDITION_TYPES);

/** `any` — at least one value holds. `all` — every value holds. */
export const ROUTING_CONDITION_MATCHES = ['any', 'all'] as const;
export const RoutingConditionMatchSchema = z.enum(ROUTING_CONDITION_MATCHES);

/**
 * Matched against `messages.body` of the message that opened the ticket — which
 * is also the caption on a media message, so "the customer sent a photo captioned
 * invoice" needs no extra condition type.
 *
 * Matching is substring and case-insensitive, not word-boundary aware, so `bill`
 * matches `billing`. That is what "contains" means to the person writing the
 * rule, and the alternative — tenant-authored regular expressions — is a
 * denial-of-service surface pointed at our own worker (0007, risk 4).
 */
export const KeywordConditionSchema = z.object({
  type: z.literal('keyword'),
  match: RoutingConditionMatchSchema,
  values: z
    .array(z.string().min(1).max(ROUTING_RULE_LIMITS.keywordLength))
    .min(1)
    .max(ROUTING_RULE_LIMITS.valuesPerCondition),
});

/** Read from `contact_tags` for the ticket's contact. */
export const TagConditionSchema = z.object({
  type: z.literal('tag'),
  match: RoutingConditionMatchSchema,
  tagIds: z.array(IdSchema).min(1).max(ROUTING_RULE_LIMITS.valuesPerCondition),
});

/**
 * `true` — the ticket arrived inside the tenant's business hours. `false` —
 * outside them.
 *
 * A tenant with no configured hours evaluates **false** either way, so the rule
 * does not match and evaluation continues to the next one (0007, decision 3).
 */
export const BusinessHoursConditionSchema = z.object({
  type: z.literal('business_hours'),
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

/** The two operators that compare against nothing, so `value` must be null. */
export const VALUELESS_CONTACT_ATTRIBUTE_OPERATORS = ['is_set', 'is_not_set'] as const;

export function contactAttributeOperatorTakesValue(operator: ContactAttributeOperator): boolean {
  return !VALUELESS_CONTACT_ATTRIBUTE_OPERATORS.some((candidate) => candidate === operator);
}

/**
 * Reads `contacts.custom_fields`, and only those — not the built-in contact
 * columns. The key must name a row in `custom_field_defs`, which gives the
 * console a dropdown to populate and the API something to validate against; a
 * free-text attribute path would be a typo that silently never matches.
 */
export const ContactAttributeConditionSchema = z
  .object({
    type: z.literal('contact_attribute'),
    key: z
      .string()
      .min(1)
      .max(ROUTING_RULE_FIELD_LENGTHS.attributeKey)
      .regex(/^[a-z][a-z0-9_]*$/),
    operator: ContactAttributeOperatorSchema,
    /** Null exactly when the operator is `is_set` or `is_not_set`. */
    value: z.string().max(ROUTING_RULE_FIELD_LENGTHS.attributeValue).nullable(),
  })
  .refine(
    (condition) =>
      contactAttributeOperatorTakesValue(condition.operator) === (condition.value !== null),
    {
      message: '`value` is required for every operator except `is_set` and `is_not_set`',
    },
  );

/**
 * Conditions inside one rule combine with AND. Rules combine with OR, by being an
 * ordered list — which is why there is no `any`/`all` toggle at the rule level and
 * no nested boolean tree. A supervisor who wants "billing OR invoices" writes one
 * keyword condition with two values (0007, decision 3).
 */
export const RoutingConditionSchema = z.discriminatedUnion('type', [
  KeywordConditionSchema,
  TagConditionSchema,
  BusinessHoursConditionSchema,
  ContactAttributeConditionSchema,
]);

/**
 * Exactly one target. Both, or neither, is `validation_failed`.
 *
 * A discriminated union on the wire and two nullable foreign keys in the
 * database: the union is what makes "exactly one" unrepresentable-if-wrong for
 * the console, the columns are what give the target a foreign key.
 */
export const RoutingTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('team'), teamId: IdSchema }),
  z.object({ kind: z.literal('user'), userId: IdSchema }),
]);

export const RoutingRuleNameSchema = z.string().min(1).max(ROUTING_RULE_FIELD_LENGTHS.name);

export const RoutingConditionListSchema = z
  .array(RoutingConditionSchema)
  .min(1)
  .max(ROUTING_RULE_LIMITS.conditionsPerRule);

export const AssignmentRuleResponseSchema = z.object({
  id: IdSchema,
  /** Unique per tenant, case-insensitively — it is what the ticket event names. */
  name: RoutingRuleNameSchema,
  /** Ascending. Ties break on `id`, which is creation order. */
  position: z.int().min(0),
  isActive: z.boolean(),
  conditions: RoutingConditionListSchema,
  /**
   * Null only on a rule deactivated by the removal of its target user
   * (`users.service.ts`). Such a rule cannot be re-enabled until it has one
   * again — the API answers `validation_failed`, so the console must not offer it.
   */
  target: RoutingTargetSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const AssignmentRuleCreateInputSchema = z.object({
  name: RoutingRuleNameSchema,
  conditions: RoutingConditionListSchema,
  target: RoutingTargetSchema,
  /** Omitted, the rule is appended last — `max(position) + 1`, computed server-side. */
  position: z.int().min(0).optional(),
  isActive: z.boolean().default(true),
});

export const AssignmentRuleUpdateInputSchema = AssignmentRuleCreateInputSchema.partial();

export const AssignmentRuleReorderInputSchema = z.object({
  /**
   * The tenant's **complete** rule set, in the order it should evaluate — not a
   * delta. A submitted set that is not exactly the tenant's current set means
   * another supervisor added or deleted a rule since this client loaded, and the
   * API answers `conflict` rather than reordering half of it.
   */
  ruleIds: z.array(IdSchema).max(ROUTING_RULE_LIMITS.rulesPerTenant),
});

/**
 * The list does not paginate, and keeps `CursorPage`'s shape so a generic list
 * client works against it unchanged. `rulesPerTenant` is enforced on create, so a
 * bounded response is a promise the server can actually keep (0007, REST surface).
 */
export const AssignmentRuleListResponseSchema = z.object({
  items: z.array(AssignmentRuleResponseSchema),
  /** Always null. This list is bounded by `ROUTING_RULE_LIMITS.rulesPerTenant`. */
  nextCursor: z.null(),
});

export type RoutingConditionType = z.infer<typeof RoutingConditionTypeSchema>;
export type RoutingConditionMatch = z.infer<typeof RoutingConditionMatchSchema>;
export type KeywordCondition = z.infer<typeof KeywordConditionSchema>;
export type TagCondition = z.infer<typeof TagConditionSchema>;
export type BusinessHoursCondition = z.infer<typeof BusinessHoursConditionSchema>;
export type ContactAttributeOperator = z.infer<typeof ContactAttributeOperatorSchema>;
export type ContactAttributeCondition = z.infer<typeof ContactAttributeConditionSchema>;
export type RoutingCondition = z.infer<typeof RoutingConditionSchema>;
export type RoutingTarget = z.infer<typeof RoutingTargetSchema>;
export type AssignmentRuleResponse = z.infer<typeof AssignmentRuleResponseSchema>;
export type AssignmentRuleCreateInput = z.infer<typeof AssignmentRuleCreateInputSchema>;
export type AssignmentRuleUpdateInput = z.infer<typeof AssignmentRuleUpdateInputSchema>;
export type AssignmentRuleReorderInput = z.infer<typeof AssignmentRuleReorderInputSchema>;
export type AssignmentRuleListResponse = z.infer<typeof AssignmentRuleListResponseSchema>;

// ---------------------------------------------------------------------------
// Rotation policy — 0008 (TAR-271), everything below the seam
// ---------------------------------------------------------------------------

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
// The fallback seam
// ---------------------------------------------------------------------------

export const FALLBACK_ASSIGNMENT_OUTCOMES = ['assigned', 'no_eligible_agent'] as const;
export const FallbackAssignmentOutcomeSchema = z.enum(FALLBACK_ASSIGNMENT_OUTCOMES);

/**
 * Why rotation had nobody. Three values rather than two, because they need
 * different people to act, and collapsing them sends a supervisor hunting for
 * absent colleagues who were never configured.
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
