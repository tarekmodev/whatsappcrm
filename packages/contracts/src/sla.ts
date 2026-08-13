import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { CursorPageQuerySchema } from './pagination';
import { TicketPrioritySchema, type TicketSla } from './tickets';

/**
 * SLA timers and supervisor alerts (TAR-26). The transport constants, the
 * configuration surface and the alert resource, published by TAR-280 exactly as
 * `docs/architecture/0006-sla-timers-and-supervisor-alerts.md` specifies them.
 *
 * The ticket-facing half of this feature is **not** here: `TicketSlaSchema`,
 * `SLA_STATES`, `TICKET_STATUS_PAUSES_SLA` and the `sla_breached` ticket event
 * type all shipped with TAR-73 in `tickets.ts`, and this file deliberately does
 * not restate them. What 0006 adds is the mechanism (a queue, two jobs, one
 * trigger payload) and the two resources the mechanism produces — a policy a
 * supervisor edits, and an alert a supervisor reads.
 *
 * **Why the triggers are queue jobs and not a service call.** `SlaModule` is an
 * L4 module: `TicketsModule` and `ConversationsModule` sit below it and may not
 * import it. Both need to tell it that something happened, so what crosses the
 * line is this shape and a BullMQ queue — the same arrangement
 * `ticket-linking.ts` makes between conversations and tickets, for the same
 * layering reason. `domain-events.ts` is the wrong bus for it in as many words:
 * "a subscriber for which loss is not acceptable — TAR-23's assignment, TAR-26's
 * SLA timers — needs a durable trigger of its own."
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Platform default, seeded per tenant at provisioning. TAR-26's stated
 * assumption, "first response within 1 hour".
 *
 * A **seed value, not a runtime fallback**: a tenant that edited its policy, or
 * turned SLA off with `isActive: false`, has decided something, and nothing
 * reasserts these numbers over that decision. `resolutionMinutes` stays null, so
 * only the first-response timer exists at v1 (0006, decision 6).
 */
export const SLA_DEFAULTS = {
  firstResponseMinutes: 60,
  resolutionMinutes: null,
} as const;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** BullMQ queue owned by `SlaModule`. */
export const SLA_QUEUE = 'sla';

/**
 * Reconcile every timer on one ticket.
 *
 * Idempotent by construction: the handler re-derives the whole timer state from
 * the ticket row rather than trusting the trigger, so a job that is lost,
 * duplicated or delivered out of order converges on the same state. That is what
 * makes one job serve all four ticket-level triggers instead of five specialised
 * ones that would each have to be correct about ordering against the other four.
 */
export const SLA_EVALUATE_TICKET_JOB = 'sla.evaluate-ticket';

/** The repeatable breach sweep. Installed under the scheduler key `sla-sweep`. */
export const SLA_SWEEP_JOB = 'sla.sweep';

/**
 * Why a ticket is being re-evaluated. **For logs only** — see the field's own
 * note. Kept as a closed set so a producer cannot invent a reason that no
 * dashboard filter knows about.
 */
export const SLA_EVALUATE_REASONS = [
  'ticket_created',
  'agent_replied',
  'status_changed',
  'customer_replied',
] as const;

export const SlaEvaluateReasonSchema = z.enum(SLA_EVALUATE_REASONS);

export const SlaEvaluateTicketTriggerSchema = z.object({
  tenantId: IdSchema,
  ticketId: IdSchema,
  /** For logs only. The handler reconciles from the row and never branches on this. */
  reason: SlaEvaluateReasonSchema,
});

export type SlaEvaluateReason = z.infer<typeof SlaEvaluateReasonSchema>;
export type SlaEvaluateTicketTrigger = z.infer<typeof SlaEvaluateTicketTriggerSchema>;

/**
 * ## There is deliberately no `slaEvaluateJobId`
 *
 * This file shipped one, keyed on `(tenantId, ticketId)`, described as a
 * harmless optimisation on the premise that "BullMQ forgets a completed job's
 * id". **That premise is false for the pinned `bullmq@6.0.10`**, and the bug it
 * produced was the exact inverse of TAR-26's second acceptance criterion.
 *
 * `addStandardJob-9.lua` answers `handleDuplicatedJob` whenever the job hash key
 * `EXISTS` — in *any* state, completed included — and `removeOnComplete: 1_000`
 * keeps the newest thousand completed keys alive. `Queue.add` neither throws nor
 * signals it, so the enqueue reported `added` and nothing was logged.
 *
 * A ticket's id is stable for its whole life, so every trigger after the first
 * collapsed into the completed key of the one before it: the `ticket_created`
 * job ran, and the `agent_replied` job that should have stopped the timer was
 * silently dropped. The ticket then breached at its deadline and the supervisor
 * was alerted about a ticket that had been answered in five minutes. The same
 * collapse stopped a paused timer ever resuming.
 *
 * `ticketEnsureJobId` in `ticket-linking.ts` is safe from this only because it
 * is keyed on `messageId`, which is never reused — that is precisely the
 * property a ticket-keyed id drops, and its own docblock's "once it leaves the
 * completed set" is the wording this one got wrong.
 *
 * So these jobs carry **no custom id**. Nothing is lost by it: the handler is a
 * reconciler that re-derives the whole timer state from the ticket row, so a
 * duplicate delivery is a no-op by construction, and that — not a Redis key — is
 * what makes at-least-once delivery safe here. Anything reintroducing an id must
 * key it on the *event* that triggered the evaluation, never on the ticket.
 */

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const SLA_TARGET_KINDS = ['first_response', 'resolution'] as const;
export const SlaTargetKindSchema = z.enum(SLA_TARGET_KINDS);
export type SlaTargetKind = (typeof SLA_TARGET_KINDS)[number];

/**
 * Thirty days in minutes. An upper bound that rejects a typo — a window entered
 * in seconds, a stray zero — without pretending to know a tenant's business.
 */
export const SLA_WINDOW_MAX_MINUTES = 43_200;

const SlaWindowMinutesSchema = z.int().min(1).max(SLA_WINDOW_MAX_MINUTES);

export const SlaPolicyResponseSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(100),
  /** Null means "any priority" — the catch-all the default row uses. */
  priority: TicketPrioritySchema.nullable(),
  firstResponseMinutes: SlaWindowMinutesSchema.nullable(),
  resolutionMinutes: SlaWindowMinutesSchema.nullable(),
  /** Modelled, not implemented at v1. Always false; see 0006, risk 1. */
  businessHoursOnly: z.boolean(),
  isActive: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/**
 * A partial edit of the tenant's policy. `priority` and `businessHoursOnly` are
 * deliberately absent: the first belongs with the per-priority policy UI that is
 * not in scope, and the second is modelled but not implemented, so accepting it
 * would publish a switch that does nothing.
 */
export const SlaPolicyUpdateInputSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    firstResponseMinutes: SlaWindowMinutesSchema.nullable().optional(),
    resolutionMinutes: SlaWindowMinutesSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field',
  });

export const SlaAlertResponseSchema = z.object({
  id: IdSchema,
  ticketId: IdSchema,
  ticketNumber: z.int().positive(),
  slaTimerId: IdSchema,
  kind: SlaTargetKindSchema,
  /** The deadline that was missed, as it stood when the breach was detected. */
  dueAt: TimestampSchema,
  /** Who was holding the ticket. Null when nobody was — decision 4's fallback branch. */
  assignedUserId: IdSchema.nullable(),
  assignedTeamId: IdSchema.nullable(),
  acknowledgedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

/**
 * `unacknowledgedOnly` is parsed from a **string**, unlike the plain
 * `z.boolean()` 0006 sketched.
 *
 * The sketch is right about the published type and wrong about the wire: this is
 * a query parameter, it arrives as `"false"`, and `z.boolean()` would answer 400
 * to the one value a client sends to widen the list — making "show me everything"
 * unreachable. `z.stringbool()` parses the string and still yields a boolean, so
 * the shape a handler and a client see is the shape 0006 published. The same
 * reasoning `CursorPageQuerySchema.limit` already applies with `z.coerce.number()`.
 */
export const SlaAlertListQuerySchema = CursorPageQuerySchema.extend({
  /** Default true: the supervisor's landing view is what still needs attention. */
  unacknowledgedOnly: z.stringbool().default(true),
});

export type SlaPolicyResponse = z.infer<typeof SlaPolicyResponseSchema>;
export type SlaPolicyUpdateInput = z.infer<typeof SlaPolicyUpdateInputSchema>;
export type SlaAlertResponse = z.infer<typeof SlaAlertResponseSchema>;
export type SlaAlertListQuery = z.infer<typeof SlaAlertListQuerySchema>;

// ---------------------------------------------------------------------------
// Reading a breach off a ticket (TAR-281)
// ---------------------------------------------------------------------------

/**
 * True when either of a ticket's timers has breached — what
 * `TicketListQuery.breachedOnly` selects, read off a `TicketResponse` rather
 * than off the database.
 *
 * Here rather than in the console because two very different things have to
 * agree about it: the API's `EXISTS (… state = 'breached')`, and the overdue
 * flag the ticket queue draws on the row beside the filter. A queue that
 * filtered by one rule and drew the badge from another would be wrong in
 * exactly the case the filter exists for — and the mock transport, which is a
 * `lib/` module and may not import from `features/`, needs the same predicate.
 *
 * `breached` is terminal by design: a ticket answered after it breached still
 * stamps its first response, but the timer stays breached, because the
 * supervisor's record of the miss is not erased by a late reply.
 */
export function isSlaBreached(sla: TicketSla): boolean {
  return sla.firstResponseState === 'breached' || sla.resolutionState === 'breached';
}
