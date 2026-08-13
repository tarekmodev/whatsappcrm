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
 * ⚠️ 0007 also specifies the queue trigger (`TicketRoutingTrigger`), the routing
 * result (`TicketRoutingResult`) and the `FallbackAssignmentResolver` seam, and
 * puts them in this file too. Those describe the evaluation engine, which is
 * TAR-288's, and nothing in `apps/web` reads them — so TAR-289 transcribed only
 * the half it consumes rather than guessing at the other one. They are additive
 * here when TAR-288 lands.
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
