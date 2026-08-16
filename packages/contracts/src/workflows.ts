import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { CursorPageQuerySchema } from './pagination';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TicketPrioritySchema,
  TicketStatusSchema,
} from './tickets';

/**
 * Workflow automation: the trigger / condition / action grammar a supervisor
 * writes, and the CRUD, catalog, dry-run and run surfaces behind it (TAR-27).
 *
 * Fixed by `docs/architecture/0009-workflow-triggers-conditions-actions.md`
 * (TAR-392). This file is that document's *grammar and DTO* half, transcribed so
 * `apps/api` and `apps/web` validate against one object rather than two readings
 * of a markdown table.
 *
 * ⚠️ **This is the half `apps/web` consumes** — everything the rule-list builder
 * (TAR-396) renders, submits and parses. 0009 also specifies a queue trigger
 * (`WorkflowEvaluateTicketTrigger`, `workflowDedupeKey`, `workflowEvaluateJobId`)
 * and the `notifications` generalisation, both of which only the worker uses.
 * Those are **additive** and land with TAR-395, exactly as `assignment.ts` grew
 * its transport half after TAR-289 had transcribed the console's. Any change to
 * what *is* here goes back through 0009, never agreed between two stories.
 */

/**
 * Caps the engine enforces, published so the API, the console and 0009 cannot
 * drift. None is a limit a real tenant meets: evaluation cost per triggering
 * occurrence is `workflows × conditions`, and `workflow_runs` grows with ticket
 * volume rather than with anything a supervisor can see (0009 — Limits).
 */
export const WORKFLOW_LIMITS = {
  /** Active and inactive together. The evaluator loads the matching active set whole. */
  workflowsPerTenant: 50,
  /** Conditions in one workflow, all of which must hold. */
  conditionsPerWorkflow: 10,
  /** Actions in one workflow, executed in order. */
  actionsPerWorkflow: 5,
  /** Values in one multi-value condition. */
  valuesPerCondition: 25,
  /** Workflows in one tenant carrying an elapsed trigger. Each one is sweep work. */
  elapsedTriggerWorkflowsPerTenant: 10,
  /** Runs one ticket may produce in one hour, across every workflow. Loop protection. */
  runsPerTicketPerHour: 20,
  /** How deep a chain of workflow-caused triggers may go. */
  maxChainDepth: 3,
  /** Runs older than this are swept. `workflow_runs` is a log, not a ledger. */
  runsRetentionDays: 90,
} as const;

/**
 * The field lengths 0009 writes as literals inside its schemas. Named here so a
 * form's `maxLength` and the schema that refuses the value cannot disagree —
 * `ROUTING_RULE_FIELD_LENGTHS`' precedent, for the same reason.
 */
export const WORKFLOW_FIELD_LENGTHS = {
  name: 80,
  /** `notify.message`, shown verbatim to the recipient. */
  notifyMessage: 280,
} as const;

/**
 * The elapsed trigger's window, in minutes: five minutes to thirty days.
 *
 * The floor is the sweep interval's promise — below one tick, "escalate after N
 * minutes" is a deadline the sweep cannot keep (0009 decision 3).
 */
export const WORKFLOW_ELAPSED_MINUTES = { min: 5, max: 43_200 } as const;

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const WORKFLOW_TRIGGER_TYPES = [
  /** A ticket row was created — the linker's `created` path, or TAR-25's manual create. */
  'ticket_created',
  /** A `status_changed` ticket event was written, by an agent or by the system. */
  'ticket_status_changed',
  /** An `assigned` or `unassigned` ticket event was written. */
  'ticket_assigned',
  /** An SLA timer flipped to `breached` and its alerts committed (0006 decision 3). */
  'ticket_sla_breached',
  /** The ticket has been active for at least `minutes`. Detected by the sweep. */
  'ticket_unresolved_for',
] as const;

export const WorkflowTriggerTypeSchema = z.enum(WORKFLOW_TRIGGER_TYPES);

/** The one trigger that carries a parameter, and the only one the sweep serves. */
export const ELAPSED_WORKFLOW_TRIGGER_TYPE = 'ticket_unresolved_for';

export const ElapsedTriggerSchema = z.object({
  type: z.literal(ELAPSED_WORKFLOW_TRIGGER_TYPE),
  minutes: z.int().min(WORKFLOW_ELAPSED_MINUTES.min).max(WORKFLOW_ELAPSED_MINUTES.max),
});

const eventTrigger = <T extends string>(type: T) => z.object({ type: z.literal(type) });

export const WorkflowTriggerSchema = z.discriminatedUnion('type', [
  eventTrigger('ticket_created'),
  eventTrigger('ticket_status_changed'),
  eventTrigger('ticket_assigned'),
  eventTrigger('ticket_sla_breached'),
  ElapsedTriggerSchema,
]);

/**
 * True when the trigger type takes a `minutes` parameter — the one shape
 * difference the builder's trigger picker has to render.
 */
export function workflowTriggerTakesMinutes(type: WorkflowTriggerType): boolean {
  return type === ELAPSED_WORKFLOW_TRIGGER_TYPE;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export const WORKFLOW_SET_OPERATORS = ['in', 'not_in'] as const;
export const WORKFLOW_MATCH_OPERATORS = ['any', 'all', 'none'] as const;
export const WORKFLOW_NUMBER_OPERATORS = ['gte', 'lte'] as const;

export const WorkflowSetOperatorSchema = z.enum(WORKFLOW_SET_OPERATORS);
export const WorkflowMatchOperatorSchema = z.enum(WORKFLOW_MATCH_OPERATORS);
export const WorkflowNumberOperatorSchema = z.enum(WORKFLOW_NUMBER_OPERATORS);

export const TicketStatusConditionSchema = z.object({
  type: z.literal('ticket_status'),
  operator: WorkflowSetOperatorSchema,
  values: z.array(TicketStatusSchema).min(1).max(TICKET_STATUSES.length),
});

export const TicketPriorityConditionSchema = z.object({
  type: z.literal('ticket_priority'),
  operator: WorkflowSetOperatorSchema,
  values: z.array(TicketPrioritySchema).min(1).max(TICKET_PRIORITIES.length),
});

export const WORKFLOW_ASSIGNMENT_STATES = [
  'unassigned',
  'assigned_to_user',
  'assigned_to_team',
] as const;

export const WorkflowAssignmentStateSchema = z.enum(WORKFLOW_ASSIGNMENT_STATES);

export const TicketAssignmentConditionSchema = z
  .object({
    type: z.literal('ticket_assignment'),
    state: WorkflowAssignmentStateSchema,
    /** Narrows the state to one team. Null means "any team". */
    teamId: IdSchema.nullable().default(null),
    /** Narrows the state to one user. Null means "any user". */
    userId: IdSchema.nullable().default(null),
  })
  .refine((condition) => !(condition.state === 'unassigned' && condition.teamId !== null), {
    message: '`unassigned` takes no teamId',
  })
  .refine((condition) => !(condition.state === 'unassigned' && condition.userId !== null), {
    message: '`unassigned` takes no userId',
  })
  .refine((condition) => !(condition.state === 'assigned_to_user' && condition.teamId !== null), {
    message: '`assigned_to_user` takes no teamId',
  })
  .refine((condition) => !(condition.state === 'assigned_to_team' && condition.userId !== null), {
    message: '`assigned_to_team` takes no userId',
  });

/** Tags on the ticket (`ticket_tags`), which only a workflow writes at v1. */
export const TicketTagConditionSchema = z.object({
  type: z.literal('ticket_tag'),
  match: WorkflowMatchOperatorSchema,
  tagIds: z.array(IdSchema).min(1).max(WORKFLOW_LIMITS.valuesPerCondition),
});

/** Tags on the ticket's contact (`contact_tags`) — 0007's `tag` condition's data. */
export const ContactTagConditionSchema = z.object({
  type: z.literal('contact_tag'),
  match: WorkflowMatchOperatorSchema,
  tagIds: z.array(IdSchema).min(1).max(WORKFLOW_LIMITS.valuesPerCondition),
});

/** Minutes since `tickets.created_at`, against Postgres `now()`. */
export const TicketAgeConditionSchema = z.object({
  type: z.literal('ticket_age'),
  operator: WorkflowNumberOperatorSchema,
  minutes: z.int().min(1).max(WORKFLOW_ELAPSED_MINUTES.max),
});

/**
 * `isWithinBusinessHours` from 0007, unchanged — including its fail-false rule:
 * a tenant with no configured hours evaluates **false** whichever way `within`
 * is set, so a workflow does not fire on a tenant that configured nothing.
 */
export const WorkflowBusinessHoursConditionSchema = z.object({
  type: z.literal('business_hours'),
  within: z.boolean(),
});

/**
 * Conditions inside one workflow combine with **AND**. There is no OR and no
 * nesting: a supervisor wanting OR writes two workflows, because every matching
 * workflow runs (0009 decision 4). A tree the rule-list UI cannot render is a
 * grammar the API would validate for ever without a caller.
 */
export const WorkflowConditionSchema = z.discriminatedUnion('type', [
  TicketStatusConditionSchema,
  TicketPriorityConditionSchema,
  TicketAssignmentConditionSchema,
  TicketTagConditionSchema,
  ContactTagConditionSchema,
  TicketAgeConditionSchema,
  WorkflowBusinessHoursConditionSchema,
]);

export const WORKFLOW_CONDITION_TYPES = [
  'ticket_status',
  'ticket_priority',
  'ticket_assignment',
  'ticket_tag',
  'contact_tag',
  'ticket_age',
  'business_hours',
] as const;

export const WorkflowConditionTypeSchema = z.enum(WORKFLOW_CONDITION_TYPES);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Exactly the launch set TAR-27 commits to. Every one of them is **internal** —
 * something a supervisor can already do by hand — which is what lets
 * `workflow:write` reach supervisor at all. An action that reaches a customer
 * needs a separate admin-only permission, checked at workflow-write time
 * (0009 — Security and Access).
 */
export const WORKFLOW_ACTION_TYPES = [
  'add_ticket_tag',
  'reassign',
  'notify',
  'set_status',
  'set_priority',
] as const;

export const WorkflowActionTypeSchema = z.enum(WORKFLOW_ACTION_TYPES);

export const AddTicketTagActionSchema = z.object({
  type: z.literal('add_ticket_tag'),
  /** Must name a `tags.id` in this tenant. A workflow never creates a tag. */
  tagId: IdSchema,
});

/** Exactly one target, on `RoutingTargetSchema`'s reasoning (0007 decision 4). */
export const WorkflowAssigneeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('team'), teamId: IdSchema }),
  z.object({ kind: z.literal('user'), userId: IdSchema }),
]);

export const ReassignActionSchema = z.object({
  type: z.literal('reassign'),
  target: WorkflowAssigneeSchema,
});

export const WORKFLOW_NOTIFY_AUDIENCES = [
  /** The ticket-holder's supervisors, resolved as 0006 decision 4 resolves them. */
  'supervisors',
  'user',
  'team',
] as const;

export const WorkflowNotifyAudienceSchema = z.enum(WORKFLOW_NOTIFY_AUDIENCES);

/** Which id an audience carries — `null` for the one that resolves its own. */
export function workflowNotifyAudienceTarget(
  audience: WorkflowNotifyAudience,
): 'user' | 'team' | null {
  switch (audience) {
    case 'user':
      return 'user';
    case 'team':
      return 'team';
    case 'supervisors':
      return null;
  }
}

export const NotifyActionSchema = z
  .object({
    type: z.literal('notify'),
    audience: WorkflowNotifyAudienceSchema,
    /** Non-null exactly when `audience` is `user`. */
    userId: IdSchema.nullable().default(null),
    /** Non-null exactly when `audience` is `team`. Every active member is a recipient. */
    teamId: IdSchema.nullable().default(null),
    /** Shown verbatim to the recipient. No interpolation at v1 (0009 risk 6). */
    message: z.string().min(1).max(WORKFLOW_FIELD_LENGTHS.notifyMessage).nullable().default(null),
  })
  .refine(
    (action) =>
      (workflowNotifyAudienceTarget(action.audience) === 'user') === (action.userId !== null),
    { message: '`userId` is required for the `user` audience and forbidden for every other' },
  )
  .refine(
    (action) =>
      (workflowNotifyAudienceTarget(action.audience) === 'team') === (action.teamId !== null),
    { message: '`teamId` is required for the `team` audience and forbidden for every other' },
  );

export const SetStatusActionSchema = z.object({
  type: z.literal('set_status'),
  status: TicketStatusSchema,
});

export const SetPriorityActionSchema = z.object({
  type: z.literal('set_priority'),
  priority: TicketPrioritySchema,
});

/** Executed sequentially, in the declared order; a failure stops the rest. */
export const WorkflowActionSchema = z.discriminatedUnion('type', [
  AddTicketTagActionSchema,
  ReassignActionSchema,
  NotifyActionSchema,
  SetStatusActionSchema,
  SetPriorityActionSchema,
]);

// ---------------------------------------------------------------------------
// The workflow resource
// ---------------------------------------------------------------------------

export const WORKFLOW_BROKEN_REASONS = [
  /** A referenced user was removed; the removal transaction deactivated this. */
  'reference_removed',
  /** A reference went missing at evaluation time and failed a run, loudly. */
  'reference_missing',
] as const;

export const WorkflowBrokenReasonSchema = z.enum(WORKFLOW_BROKEN_REASONS);

export const WORKFLOW_TAXONOMY_KINDS = ['tag', 'team', 'user'] as const;
export const WorkflowTaxonomyKindSchema = z.enum(WORKFLOW_TAXONOMY_KINDS);

/**
 * Every taxonomy id the definition names, **resolved live at read time and never
 * stored** (0009 decision 6, mechanism 2).
 *
 * A rename therefore requires nothing at all, and `exists: false` is what makes
 * breakage *visible*: the console renders a broken reference in the rule list
 * without a second request. A response embedding a stored name would show the
 * old one and look healthy.
 */
export const WorkflowReferenceSchema = z.object({
  kind: WorkflowTaxonomyKindSchema,
  id: IdSchema,
  /** Null exactly when `exists` is false. */
  name: z.string().nullable(),
  exists: z.boolean(),
});

export const WorkflowNameSchema = z.string().min(1).max(WORKFLOW_FIELD_LENGTHS.name);

/** Empty is legal: "every time this trigger fires, do this" (0009 decision 4). */
export const WorkflowConditionListSchema = z
  .array(WorkflowConditionSchema)
  .max(WORKFLOW_LIMITS.conditionsPerWorkflow);

export const WorkflowActionListSchema = z
  .array(WorkflowActionSchema)
  .min(1)
  .max(WORKFLOW_LIMITS.actionsPerWorkflow);

export const WorkflowResponseSchema = z.object({
  id: IdSchema,
  /** Unique per tenant, case-insensitively. */
  name: WorkflowNameSchema,
  /**
   * Ascending; ties break on `id`, which is creation order. **Execution** order,
   * not selection — every matching workflow runs, unlike a routing rule.
   */
  position: z.int().min(0),
  isActive: z.boolean(),
  /** Non-null exactly when the workflow was auto-deactivated. Blocks re-enabling. */
  brokenReason: WorkflowBrokenReasonSchema.nullable(),
  version: z.int().min(1),
  trigger: WorkflowTriggerSchema,
  conditions: WorkflowConditionListSchema,
  actions: WorkflowActionListSchema,
  references: z.array(WorkflowReferenceSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const WorkflowCreateInputSchema = z.object({
  name: WorkflowNameSchema,
  trigger: WorkflowTriggerSchema,
  conditions: WorkflowConditionListSchema.default([]),
  actions: WorkflowActionListSchema,
  /** Omitted, the workflow is appended last. */
  position: z.int().min(0).optional(),
  /**
   * Default `false`, unlike an assignment rule: a rule that writes to tickets is
   * armed on purpose. The console's flow is create → dry-run → enable.
   */
  isActive: z.boolean().default(false),
});

/**
 * Partial update: **absent means unchanged**, for every field.
 *
 * Spelled out rather than written as `WorkflowCreateInputSchema.partial()`,
 * which would be wrong in a way that is invisible at the call site. `.partial()`
 * makes a field optional but leaves its `.default()` in place, so parsing
 * `{ isActive: true }` against the partial create schema yields
 * `{ isActive: true, conditions: [] }` — and a supervisor arming a workflow from
 * the list would silently delete every condition it had.
 *
 * ⚠️ `AssignmentRuleUpdateInputSchema` is written the other way and has the same
 * latent behaviour (`isActive` defaults to `true` there, so a bare rename would
 * re-enable a disabled rule). No caller reaches it today — the console always
 * sends `isActive` explicitly — so it is raised on TAR-396 for 0007's owner
 * rather than changed here.
 */
export const WorkflowUpdateInputSchema = z.object({
  name: WorkflowNameSchema.optional(),
  trigger: WorkflowTriggerSchema.optional(),
  conditions: WorkflowConditionListSchema.optional(),
  actions: WorkflowActionListSchema.optional(),
  position: z.int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const WorkflowReorderInputSchema = z.object({
  /**
   * The tenant's **complete** workflow set, in the order it should execute — not
   * a delta. A set that is not exactly the current one means somebody else added
   * or removed a workflow since this client loaded, and the API answers
   * `conflict` rather than reordering half of it.
   */
  workflowIds: z.array(IdSchema).max(WORKFLOW_LIMITS.workflowsPerTenant),
});

/**
 * The list does not paginate and keeps `CursorPage`'s shape, so a generic list
 * client works against it unchanged. `workflowsPerTenant` is enforced on create,
 * so a bounded response is a promise the server can keep.
 */
export const WorkflowListResponseSchema = z.object({
  items: z.array(WorkflowResponseSchema),
  /** Always null. This list is bounded by `WORKFLOW_LIMITS.workflowsPerTenant`. */
  nextCursor: z.null(),
});

// ---------------------------------------------------------------------------
// Runs — "did my rule fire, and what did it do?"
// ---------------------------------------------------------------------------

export const WORKFLOW_RUN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  /** Conditions did not match. Not a failure — it is the answer to "why not?". */
  'skipped',
  'failed',
] as const;

export const WorkflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);

export const WORKFLOW_FAILURE_REASONS = [
  /** A tag, team or user the definition names no longer exists. Deactivates it. */
  'reference_missing',
  /** `TICKET_STATUS_TRANSITIONS` refuses the move — reopening a closed ticket. */
  'transition_refused',
  /** The ticket was deleted, or is no longer visible, between claim and action. */
  'ticket_gone',
  /** The tenant hit `runsPerTicketPerHour`. Loop protection, not a fault. */
  'run_budget_exceeded',
  /** Everything else. `error` carries the detail; the log line carries the stack. */
  'internal_error',
] as const;

export const WorkflowFailureReasonSchema = z.enum(WORKFLOW_FAILURE_REASONS);

/**
 * `no_op` is not `applied`: setting a status the ticket already holds, or adding
 * a tag it already carries, changed nothing — and "it ran and changed nothing"
 * is the answer to half the questions a supervisor brings.
 */
export const WORKFLOW_ACTION_OUTCOMES = ['applied', 'no_op', 'failed', 'skipped'] as const;

export const WorkflowActionOutcomeSchema = z.enum(WORKFLOW_ACTION_OUTCOMES);

export const WorkflowActionResultSchema = z.object({
  /** Index into the definition's `actions`, so a result maps back to what was written. */
  index: z.int().min(0),
  type: WorkflowActionTypeSchema,
  outcome: WorkflowActionOutcomeSchema,
  /** A `WorkflowFailureReason` on `failed`; null otherwise. */
  reason: z.string().nullable(),
});

export const WorkflowRunResponseSchema = z.object({
  id: IdSchema,
  workflowId: IdSchema,
  workflowVersion: z.int().min(1),
  ticketId: IdSchema,
  ticketNumber: z.int().positive(),
  status: WorkflowRunStatusSchema,
  triggerType: WorkflowTriggerTypeSchema,
  /** Empty on `skipped` — nothing was attempted. */
  results: z.array(WorkflowActionResultSchema),
  failureReason: WorkflowFailureReasonSchema.nullable(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

// ---------------------------------------------------------------------------
// The dry run
// ---------------------------------------------------------------------------

export const WorkflowTestInputSchema = z.object({ ticketId: IdSchema });

/**
 * What **would** happen. It writes nothing — no run row, no ticket write, no
 * notification, no socket — which is why it is a separate endpoint rather than a
 * `commit: boolean` one typo away from closing a real ticket.
 */
export const WorkflowTestResponseSchema = z.object({
  matched: z.boolean(),
  conditions: z.array(
    z.object({
      index: z.int().min(0),
      type: WorkflowConditionTypeSchema,
      held: z.boolean(),
      /** Why a condition could not be evaluated: `no_contact`, `business_hours_unconfigured`. */
      reason: z.string().nullable(),
    }),
  ),
  /** Empty when `matched` is false. */
  actions: z.array(
    z.object({
      index: z.int().min(0),
      type: WorkflowActionTypeSchema,
      /** `applied` means "would apply"; `no_op` means the ticket is already there. */
      outcome: WorkflowActionOutcomeSchema,
      /** Human-readable, resolved: `Reassign to team "Escalations"`. */
      describes: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * ⚠️ 0009 names `WorkflowParameterSchema` and gives one example of its shape
 * (`{ name: 'minutes', kind: 'int', min: 5, max: 43200 }`) without publishing its
 * fields. This is that example generalised to the five parameters the launch
 * grammar actually has, and it is the **one shape in this file not fixed by
 * 0009** — raised on TAR-396 for the Architect to confirm or correct in 0009
 * rather than settled between the console and the API.
 */
export const WORKFLOW_PARAMETER_KINDS = ['int', 'enum', 'taxonomy', 'text', 'boolean'] as const;

export const WorkflowParameterKindSchema = z.enum(WORKFLOW_PARAMETER_KINDS);

export const WorkflowParameterSchema = z.object({
  /** The field's name in the trigger or action object. */
  name: z.string().min(1),
  kind: WorkflowParameterKindSchema,
  isRequired: z.boolean(),
  /** Inclusive bounds for `int`; null for every other kind. */
  min: z.int().nullable(),
  max: z.int().nullable(),
  /** The exact values for `enum`; null otherwise. */
  values: z.array(z.string()).nullable(),
  /** Which picker to render for `taxonomy`; null otherwise. */
  taxonomy: WorkflowTaxonomyKindSchema.nullable(),
});

/**
 * The vocabulary the **server** will accept, so a builder cannot offer an action
 * the API refuses. One endpoint rather than three: a form needs all of it before
 * it can render anything, and three endpoints would be three round trips that
 * always happen together and can disagree across a deploy (0009 — The catalog).
 */
export const WorkflowCatalogResponseSchema = z.object({
  triggers: z.array(
    z.object({
      type: WorkflowTriggerTypeSchema,
      parameters: z.array(WorkflowParameterSchema),
      /** Condition types that make sense against this trigger. All of them, at v1. */
      conditionTypes: z.array(WorkflowConditionTypeSchema),
    }),
  ),
  conditions: z.array(
    z.object({
      type: WorkflowConditionTypeSchema,
      operators: z.array(z.string()),
      /** `taxonomy: 'tag'` tells the console which picker to render. */
      taxonomy: WorkflowTaxonomyKindSchema.nullable(),
      /** For enum-valued conditions: the exact values. */
      values: z.array(z.string()).nullable(),
    }),
  ),
  actions: z.array(
    z.object({
      type: WorkflowActionTypeSchema,
      parameters: z.array(WorkflowParameterSchema),
    }),
  ),
  limits: z.object({
    workflowsPerTenant: z.int().positive(),
    conditionsPerWorkflow: z.int().positive(),
    actionsPerWorkflow: z.int().positive(),
    valuesPerCondition: z.int().positive(),
    elapsedTriggerWorkflowsPerTenant: z.int().positive(),
    runsPerTicketPerHour: z.int().positive(),
    maxChainDepth: z.int().positive(),
    runsRetentionDays: z.int().positive(),
  }),
});

/**
 * The catalog, derived from the constants above.
 *
 * 0009 asks for an endpoint even though the values are compile-time constants,
 * because the endpoint is the one that is right when the console is a version
 * behind. Building the body here is what makes the API's answer and the mock
 * transport's answer the same object rather than two transcriptions — 0009's
 * "the mock and the implementation are generated from the same source".
 */
export function workflowCatalog(): WorkflowCatalogResponse {
  return {
    triggers: WORKFLOW_TRIGGER_TYPES.map((type) => ({
      type,
      parameters: workflowTriggerTakesMinutes(type)
        ? [
            {
              name: 'minutes',
              kind: 'int',
              isRequired: true,
              min: WORKFLOW_ELAPSED_MINUTES.min,
              max: WORKFLOW_ELAPSED_MINUTES.max,
              values: null,
              taxonomy: null,
            },
          ]
        : [],
      conditionTypes: [...WORKFLOW_CONDITION_TYPES],
    })),
    conditions: WORKFLOW_CONDITION_TYPES.map((type) => ({
      type,
      operators: [...conditionOperators(type)],
      taxonomy: conditionTaxonomy(type),
      values: conditionValues(type),
    })),
    actions: WORKFLOW_ACTION_TYPES.map((type) => ({ type, parameters: actionParameters(type) })),
    limits: { ...WORKFLOW_LIMITS },
  };
}

/** The operator vocabulary one condition type offers, in the order it offers it. */
export function conditionOperators(type: WorkflowConditionType): readonly string[] {
  switch (type) {
    case 'ticket_status':
    case 'ticket_priority':
      return WORKFLOW_SET_OPERATORS;

    case 'ticket_tag':
    case 'contact_tag':
      return WORKFLOW_MATCH_OPERATORS;

    case 'ticket_age':
      return WORKFLOW_NUMBER_OPERATORS;

    // Neither compares: an assignment condition names a state, and a
    // business-hours condition is a boolean.
    case 'ticket_assignment':
    case 'business_hours':
      return [];
  }
}

/** Which picker a condition needs, or `null` for a literal enum. */
export function conditionTaxonomy(type: WorkflowConditionType): WorkflowTaxonomyKind | null {
  switch (type) {
    case 'ticket_tag':
    case 'contact_tag':
      return 'tag';

    // Narrowing an assignment state takes *either* a team or a user, so the
    // condition names no single taxonomy. The form renders both, gated on state.
    case 'ticket_assignment':
    case 'ticket_status':
    case 'ticket_priority':
    case 'ticket_age':
    case 'business_hours':
      return null;
  }
}

function conditionValues(type: WorkflowConditionType): string[] | null {
  switch (type) {
    case 'ticket_status':
      return [...TICKET_STATUSES];

    case 'ticket_priority':
      return [...TICKET_PRIORITIES];

    case 'ticket_assignment':
      return [...WORKFLOW_ASSIGNMENT_STATES];

    case 'ticket_tag':
    case 'contact_tag':
    case 'ticket_age':
    case 'business_hours':
      return null;
  }
}

function actionParameters(type: WorkflowActionType): WorkflowParameter[] {
  switch (type) {
    case 'add_ticket_tag':
      return [parameter({ name: 'tagId', kind: 'taxonomy', taxonomy: 'tag' })];

    case 'reassign':
      // One field on the wire, two pickers in the form: the target is a
      // discriminated union, so the console reads `kind` and renders one of them.
      return [parameter({ name: 'target', kind: 'taxonomy', taxonomy: 'team' })];

    case 'notify':
      return [
        parameter({ name: 'audience', kind: 'enum', values: [...WORKFLOW_NOTIFY_AUDIENCES] }),
        parameter({ name: 'userId', kind: 'taxonomy', taxonomy: 'user', isRequired: false }),
        parameter({ name: 'teamId', kind: 'taxonomy', taxonomy: 'team', isRequired: false }),
        parameter({
          name: 'message',
          kind: 'text',
          isRequired: false,
          max: WORKFLOW_FIELD_LENGTHS.notifyMessage,
        }),
      ];

    case 'set_status':
      return [parameter({ name: 'status', kind: 'enum', values: [...TICKET_STATUSES] })];

    case 'set_priority':
      return [parameter({ name: 'priority', kind: 'enum', values: [...TICKET_PRIORITIES] })];
  }
}

function parameter(
  overrides: Pick<WorkflowParameter, 'name' | 'kind'> & Partial<WorkflowParameter>,
): WorkflowParameter {
  return {
    isRequired: true,
    min: null,
    max: null,
    values: null,
    taxonomy: null,
    ...overrides,
  };
}

export type WorkflowTriggerType = z.infer<typeof WorkflowTriggerTypeSchema>;
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;
export type ElapsedTrigger = z.infer<typeof ElapsedTriggerSchema>;
export type WorkflowSetOperator = z.infer<typeof WorkflowSetOperatorSchema>;
export type WorkflowMatchOperator = z.infer<typeof WorkflowMatchOperatorSchema>;
export type WorkflowNumberOperator = z.infer<typeof WorkflowNumberOperatorSchema>;
export type WorkflowAssignmentState = z.infer<typeof WorkflowAssignmentStateSchema>;
export type TicketStatusCondition = z.infer<typeof TicketStatusConditionSchema>;
export type TicketPriorityCondition = z.infer<typeof TicketPriorityConditionSchema>;
export type TicketAssignmentCondition = z.infer<typeof TicketAssignmentConditionSchema>;
export type TicketTagCondition = z.infer<typeof TicketTagConditionSchema>;
export type ContactTagCondition = z.infer<typeof ContactTagConditionSchema>;
export type TicketAgeCondition = z.infer<typeof TicketAgeConditionSchema>;
export type WorkflowBusinessHoursCondition = z.infer<typeof WorkflowBusinessHoursConditionSchema>;
export type WorkflowCondition = z.infer<typeof WorkflowConditionSchema>;
export type WorkflowConditionType = z.infer<typeof WorkflowConditionTypeSchema>;
export type WorkflowActionType = z.infer<typeof WorkflowActionTypeSchema>;
export type AddTicketTagAction = z.infer<typeof AddTicketTagActionSchema>;
export type WorkflowAssignee = z.infer<typeof WorkflowAssigneeSchema>;
export type ReassignAction = z.infer<typeof ReassignActionSchema>;
export type WorkflowNotifyAudience = z.infer<typeof WorkflowNotifyAudienceSchema>;
export type NotifyAction = z.infer<typeof NotifyActionSchema>;
export type SetStatusAction = z.infer<typeof SetStatusActionSchema>;
export type SetPriorityAction = z.infer<typeof SetPriorityActionSchema>;
export type WorkflowAction = z.infer<typeof WorkflowActionSchema>;
export type WorkflowBrokenReason = z.infer<typeof WorkflowBrokenReasonSchema>;
export type WorkflowTaxonomyKind = z.infer<typeof WorkflowTaxonomyKindSchema>;
export type WorkflowReference = z.infer<typeof WorkflowReferenceSchema>;
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;
export type WorkflowCreateInput = z.infer<typeof WorkflowCreateInputSchema>;
export type WorkflowUpdateInput = z.infer<typeof WorkflowUpdateInputSchema>;
export type WorkflowReorderInput = z.infer<typeof WorkflowReorderInputSchema>;
export type WorkflowListResponse = z.infer<typeof WorkflowListResponseSchema>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowFailureReason = z.infer<typeof WorkflowFailureReasonSchema>;
export type WorkflowActionOutcome = z.infer<typeof WorkflowActionOutcomeSchema>;
export type WorkflowActionResult = z.infer<typeof WorkflowActionResultSchema>;
export type WorkflowRunResponse = z.infer<typeof WorkflowRunResponseSchema>;
export type WorkflowTestInput = z.infer<typeof WorkflowTestInputSchema>;
export type WorkflowTestResponse = z.infer<typeof WorkflowTestResponseSchema>;
export type WorkflowParameterKind = z.infer<typeof WorkflowParameterKindSchema>;
export type WorkflowParameter = z.infer<typeof WorkflowParameterSchema>;
export type WorkflowCatalogResponse = z.infer<typeof WorkflowCatalogResponseSchema>;

// ---------------------------------------------------------------------------
// Transport — the queue trigger (TAR-395)
// ---------------------------------------------------------------------------

/**
 * The half only the worker uses, added exactly as the header above said it would
 * be: additive, with nothing above it changed.
 *
 * `assignment.ts` grew the same way — TAR-289 transcribed the console's half of
 * 0007 and TAR-273 added the transport later — and for the same reason. A queue
 * name and a payload shape are not something a builder renders, but they *are*
 * something two sides of a seam have to agree on exactly, so they belong in the
 * one package both import.
 */

/** BullMQ queue owned by `WorkflowsModule`. */
export const WORKFLOWS_QUEUE = 'workflows';

/**
 * Evaluate every active workflow in one tenant against one triggering occurrence
 * on one ticket.
 *
 * Delivery is at-least-once and nothing about the handler depends on it being
 * once: the claim is `INSERT INTO workflow_runs … ON CONFLICT DO NOTHING`
 * against `UNIQUE (tenant_id, workflow_id, dedupe_key)`, so a redelivery finds
 * the occurrence already owned and moves on (0009 decision 2).
 */
export const WORKFLOW_EVALUATE_TICKET_JOB = 'workflow.evaluate-ticket';

/** The repeatable elapsed-trigger sweep. Installed under the scheduler key `workflow-sweep`. */
export const WORKFLOW_SWEEP_JOB = 'workflow.sweep';

/**
 * The trigger types whose dedupe key is the ticket itself rather than an
 * occurrence row — so `occurrenceId` is null for them and non-null for the rest.
 *
 * Exported because three places have to agree: the payload schema's refinement,
 * the dedupe key below, and the sweep that produces one of them.
 */
export const TICKET_SCOPED_TRIGGER_TYPES = [
  'ticket_created',
  ELAPSED_WORKFLOW_TRIGGER_TYPE,
] as const;

export function triggerIsTicketScoped(triggerType: WorkflowTriggerType): boolean {
  return TICKET_SCOPED_TRIGGER_TYPES.some((candidate) => candidate === triggerType);
}

export const WorkflowEvaluateTicketTriggerSchema = z
  .object({
    tenantId: IdSchema,
    ticketId: IdSchema,
    triggerType: WorkflowTriggerTypeSchema,
    /**
     * The `ticket_events` row, or the `sla_timers` row, that this occurrence
     * *is*. Null for `ticket_created` and `ticket_unresolved_for`, whose dedupe
     * key is the ticket itself.
     */
    occurrenceId: IdSchema.nullable(),
    /**
     * How many workflow runs deep this chain is. A trigger raised by a workflow
     * action carries its cause's depth plus one; anything else carries 0. Above
     * `WORKFLOW_LIMITS.maxChainDepth` the job is dropped with a warning.
     */
    depth: z
      .int()
      .min(0)
      .max(WORKFLOW_LIMITS.maxChainDepth + 1),
    /** The run whose action raised this, when one did. For the audit trail only. */
    causedByRunId: IdSchema.nullable(),
  })
  .refine(
    (trigger) => triggerIsTicketScoped(trigger.triggerType) === (trigger.occurrenceId === null),
    {
      message:
        '`occurrenceId` is null for exactly `ticket_created` and `ticket_unresolved_for`, and ' +
        'non-null for every other trigger type',
      path: ['occurrenceId'],
    },
  );

export type WorkflowEvaluateTicketTrigger = z.infer<typeof WorkflowEvaluateTicketTriggerSchema>;

/**
 * The dedupe key of 0009 decision 2 — the reservation half of `workflow_runs`.
 *
 * Pure, so the sweep and the four event paths cannot disagree about what "the
 * same occurrence" means. It carries no workflow id: the unique index is
 * `(tenant_id, workflow_id, dedupe_key)`, so every workflow gets its own claim
 * on the same occurrence and they never collide with each other — which is what
 * makes "every matching workflow runs" true.
 *
 * | Trigger                 | Key                                       | Meaning                      |
 * | ----------------------- | ----------------------------------------- | ---------------------------- |
 * | `ticket_created`        | `ticket:{ticketId}`                       | Once per ticket, ever        |
 * | `ticket_status_changed` | `ticket:{ticketId}:event:{ticketEventId}` | Once per recorded change     |
 * | `ticket_assigned`       | `ticket:{ticketId}:event:{ticketEventId}` | Once per recorded assignment |
 * | `ticket_sla_breached`   | `ticket:{ticketId}:timer:{slaTimerId}`    | Once per breached timer      |
 * | `ticket_unresolved_for` | `ticket:{ticketId}`                       | **Once per ticket, ever**    |
 *
 * The last row is the one to read twice. A sweep that re-evaluates the same
 * overdue ticket every minute would notify a supervisor every minute; this
 * constraint is what stops it, and it stops it whether or not the sweep is
 * correct.
 */
export function workflowDedupeKey(trigger: WorkflowEvaluateTicketTrigger): string {
  const ticket = `ticket:${trigger.ticketId}`;

  switch (trigger.triggerType) {
    case 'ticket_created':
    case 'ticket_unresolved_for':
      return ticket;
    case 'ticket_status_changed':
    case 'ticket_assigned':
      return `${ticket}:event:${trigger.occurrenceId ?? 'unknown'}`;
    case 'ticket_sla_breached':
      return `${ticket}:timer:${trigger.occurrenceId ?? 'unknown'}`;
  }
}

/**
 * ## There is deliberately no `workflowEvaluateJobId`
 *
 * 0009 publishes one, keyed `workflow-evaluate-{tenant}-{ticket}`, as the third
 * and explicitly non-load-bearing idempotency layer: "collapses a duplicate
 * enqueue while the first is queued".
 *
 * **That premise does not hold for the pinned `bullmq@6.0.10`**, and
 * `@whatsappcrm/contracts/sla` carries the incident report: `addStandardJob`
 * answers `handleDuplicatedJob` whenever the job hash key `EXISTS` in *any*
 * state, `removeOnComplete`/`removeOnFail` keep those keys alive for thousands
 * of jobs, and `Queue.add` neither throws nor signals it. A ticket's id is
 * stable for its whole life, so a ticket-keyed id would collapse every trigger
 * after the first into the completed key of the one before it — the
 * `ticket_status_changed` occurrence silently dropped behind the
 * `ticket_created` one, and, worse, an elapsed sweep re-enqueue dropped for ever
 * behind a job that *failed* before it could claim. That is an escalation that
 * never happens, reported nowhere.
 *
 * Nothing is lost by omitting it. The claim in `workflow_runs` is the
 * correctness mechanism and it is a unique index over a row that is inserted and
 * never re-derived, so a duplicate delivery costs one conflicting insert.
 * Anything reintroducing an id must key it on the *occurrence*, never on the
 * ticket — and must account for the failed set as well as the completed one.
 */

// ---------------------------------------------------------------------------
// What the worker reads back out of the row
// ---------------------------------------------------------------------------

/**
 * The definition as it is stored in `workflows.definition` — ids and only ids.
 *
 * Parsed on read as well as validated on write, so a row hand-edited into a
 * shape the grammar no longer accepts is a named failure rather than a silent
 * mismatch. `workflows.trigger_type` is a column duplicating `trigger.type`; the
 * service writes both in one statement, and parsing through this schema is what
 * catches a divergence.
 */
export const WorkflowDefinitionSchema = z.object({
  trigger: WorkflowTriggerSchema,
  conditions: WorkflowConditionListSchema,
  actions: WorkflowActionListSchema,
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/**
 * Every taxonomy id a definition names, in a stable order, with the field path
 * each was read from.
 *
 * Here rather than in `apps/api` because three consumers have to agree: the
 * write path that indexes `workflow_references`, the read path that resolves
 * names into `WorkflowReference`, and the `workflow_reference_broken` refusal
 * that names the broken field in `details`.
 */
export interface WorkflowReferenceUse {
  readonly kind: WorkflowTaxonomyKind;
  readonly id: string;
  /** `actions.1.tagId`, `conditions.0.teamId` — the path the console highlights. */
  readonly path: string;
}

export function workflowReferenceUses(
  conditions: readonly WorkflowCondition[],
  actions: readonly WorkflowAction[],
): WorkflowReferenceUse[] {
  const uses: WorkflowReferenceUse[] = [];

  conditions.forEach((condition, index) => {
    if (condition.type === 'ticket_assignment') {
      if (condition.teamId !== null) {
        uses.push({ kind: 'team', id: condition.teamId, path: `conditions.${index}.teamId` });
      }

      if (condition.userId !== null) {
        uses.push({ kind: 'user', id: condition.userId, path: `conditions.${index}.userId` });
      }
    }

    if (condition.type === 'ticket_tag' || condition.type === 'contact_tag') {
      for (const tagId of condition.tagIds) {
        uses.push({ kind: 'tag', id: tagId, path: `conditions.${index}.tagIds` });
      }
    }
  });

  actions.forEach((action, index) => {
    switch (action.type) {
      case 'add_ticket_tag':
        uses.push({ kind: 'tag', id: action.tagId, path: `actions.${index}.tagId` });
        break;
      case 'reassign':
        uses.push(
          action.target.kind === 'team'
            ? { kind: 'team', id: action.target.teamId, path: `actions.${index}.target.teamId` }
            : { kind: 'user', id: action.target.userId, path: `actions.${index}.target.userId` },
        );
        break;
      case 'notify':
        if (action.userId !== null) {
          uses.push({ kind: 'user', id: action.userId, path: `actions.${index}.userId` });
        }

        if (action.teamId !== null) {
          uses.push({ kind: 'team', id: action.teamId, path: `actions.${index}.teamId` });
        }

        break;
      case 'set_status':
      case 'set_priority':
        break;
    }
  });

  return uses;
}

/**
 * Why a condition could not be evaluated at all, as opposed to evaluating false
 * on data it could read.
 *
 * `WorkflowTestResponse.conditions[].reason` stays a plain string, as 0009
 * publishes it and as the console parses it. This is the closed set the server
 * actually emits, so the evaluator and the dry run cannot invent a third value
 * the console has no copy for.
 */
export const WORKFLOW_CONDITION_UNREADABLE_REASONS = [
  'no_contact',
  'business_hours_unconfigured',
] as const;

export const WorkflowConditionUnreadableReasonSchema = z.enum(
  WORKFLOW_CONDITION_UNREADABLE_REASONS,
);

export type WorkflowConditionUnreadableReason =
  (typeof WORKFLOW_CONDITION_UNREADABLE_REASONS)[number];

/**
 * The run history's query. **This list paginates and the workflow list does
 * not**, and the asymmetry is the point: workflows are capped per tenant, so an
 * unbounded response is a promise the server can keep, while runs grow with
 * ticket volume × active workflows and are exactly the unbounded set 0002's
 * pagination rule exists for.
 */
export const WorkflowRunListQuerySchema = CursorPageQuerySchema.extend({
  status: WorkflowRunStatusSchema.optional(),
});

export type WorkflowRunListQuery = z.infer<typeof WorkflowRunListQuerySchema>;

// ---------------------------------------------------------------------------
// Notifications — the `sla_alerts` generalisation (0009 decision 7)
// ---------------------------------------------------------------------------

export const NOTIFICATION_TYPES = ['sla_breach', 'workflow_notify', 'workflow_broken'] as const;

export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);

/**
 * One inbox, one unread count. `GET /api/v1/sla-alerts` keeps its path and its
 * response as a documented `type = 'sla_breach'` view over the same table, so
 * nothing that reads it had to change.
 *
 * The type-specific `data` blob is flattened into named fields here, because a
 * console rendering a list should not have to reach into an untyped object to
 * find out which workflow spoke.
 */
export const NotificationResponseSchema = z.object({
  id: IdSchema,
  type: NotificationTypeSchema,
  ticketId: IdSchema,
  ticketNumber: z.int().positive(),
  /** Present for `sla_breach` only. */
  slaTimerId: IdSchema.nullable(),
  dueAt: TimestampSchema.nullable(),
  /** The supervisor's own `notify` text, when there was one. */
  message: z.string().nullable(),
  workflowId: IdSchema.nullable(),
  workflowRunId: IdSchema.nullable(),
  acknowledgedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

export const NotificationListQuerySchema = CursorPageQuerySchema.extend({
  /** Default true: the landing view is what still needs attention. */
  unacknowledgedOnly: z.stringbool().default(true),
  type: NotificationTypeSchema.optional(),
});

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationResponse = z.infer<typeof NotificationResponseSchema>;
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;
