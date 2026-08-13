import { z } from 'zod';
import { FallbackAssignmentReasonSchema } from './assignment';
import { IdSchema, TimestampSchema } from './common';
import { CursorPageQuerySchema } from './pagination';

/**
 * Helpdesk ticketing. TAR-21 creates tickets from conversations, TAR-25 owns
 * status and priority, TAR-26 attaches SLA timers, TAR-32 reads the event log.
 *
 * A ticket is a **unit of work on** a conversation, not a copy of it. One
 * conversation accumulates many tickets over its life; messages stay on the
 * conversation so the thread is never split across tickets.
 */

export const TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Which statuses count as *live work on this contact* — the invariant TAR-73
 * makes a database constraint: at most one active ticket per contact per tenant.
 *
 * `pending` is active, and that is the whole subtlety. A ticket waiting on the
 * customer is still the open thread for that customer; when they finally reply,
 * the reply belongs to it, not to a second ticket opened beside it. Restricting
 * the invariant to `open` alone would let every `pending` conversation grow a
 * duplicate on the customer's next message.
 *
 * `resolved` and `closed` are terminal for this purpose: a contact who writes
 * back after resolution gets a new ticket. There is no reopen window at v1 —
 * see the ADR for the trigger to revisit that.
 */
export const TICKET_STATUS_IS_ACTIVE: Record<TicketStatus, boolean> = {
  open: true,
  pending: true,
  resolved: false,
  closed: false,
};

export const TICKET_ACTIVE_STATUSES = TICKET_STATUSES.filter(
  (status) => TICKET_STATUS_IS_ACTIVE[status],
);

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);

/**
 * `pending` means waiting on the customer, and that distinction is load-bearing:
 * SLA timers pause in `pending` and resume on the customer's next inbound
 * message (TAR-26). Treating it as just another open state would bill agents for
 * time they could not act on.
 */
export const TICKET_STATUS_PAUSES_SLA: Record<TicketStatus, boolean> = {
  open: false,
  pending: true,
  resolved: true,
  closed: true,
};

export const SLA_STATES = ['not_applicable', 'running', 'paused', 'met', 'breached'] as const;
export const SlaStateSchema = z.enum(SLA_STATES);

/**
 * Whether routing may still act on this ticket, and if not, why — one fact,
 * four values (0008 decision 3). Deliberately coarser than the four routing
 * outcomes: *how* a ticket got here is the event log's job, and the `assigned`
 * event already carries the rule id and name.
 *
 * | State      | Meaning                                                                                     |
 * | ---------- | ------------------------------------------------------------------------------------------- |
 * | `pending`  | Created; the routing job has not reached a conclusion. The column default.                  |
 * | `assigned` | Routing placed it — by rule or by rotation. The event log says which.                       |
 * | `deferred` | Routing ran and nobody was eligible. **This is TAR-23's "flagged for supervisor attention".** |
 * | `manual`   | A human assigned, reassigned or released it. Routing never touches it again.                |
 *
 * `manual` is load-bearing and not obvious: without it a future re-route would
 * overrule a supervisor who deliberately parked a ticket, and a background job
 * beating a person's decision is the kind of thing that gets a feature switched
 * off.
 *
 * Not a `TicketStatus` value: `status` is the ticket's *lifecycle*, and
 * overloading it would break `TICKET_STATUS_IS_ACTIVE`, `TICKET_STATUS_PAUSES_SLA`
 * and every status filter and report bucket, for a fact that is not about
 * lifecycle at all.
 */
export const TICKET_ROUTING_STATES = ['pending', 'assigned', 'deferred', 'manual'] as const;
export const TicketRoutingStateSchema = z.enum(TICKET_ROUTING_STATES);

/** Nested rather than flattened, matching `sla` and `UserResponse.security`. */
export const TicketRoutingSchema = z.object({
  state: TicketRoutingStateSchema,
  /** Non-null exactly when `state` is `deferred`. */
  deferredReason: FallbackAssignmentReasonSchema.nullable(),
  /**
   * When the flag was raised, and only ever on the first transition into
   * `deferred`. Not derivable from `createdAt` — a ticket that was assigned,
   * released and then deferred would report an age that is a lie.
   */
  deferredSince: TimestampSchema.nullable(),
});

export const TicketSlaSchema = z.object({
  policyId: IdSchema.nullable(),
  firstResponseState: SlaStateSchema,
  firstResponseDueAt: TimestampSchema.nullable(),
  resolutionState: SlaStateSchema,
  resolutionDueAt: TimestampSchema.nullable(),
});

export const TicketResponseSchema = z.object({
  id: IdSchema,
  /** Per-tenant sequential number — what agents and customers actually quote. */
  number: z.int().positive(),
  /**
   * The conversation the ticket was opened from. Nullable to match the column:
   * TAR-25 creates tickets by hand with no conversation behind them.
   *
   * For a tenant running several WhatsApp numbers this is the *originating*
   * conversation, not necessarily the one the latest message landed on — the
   * invariant is one active ticket per contact, and a contact can hold one
   * conversation per number. A message arriving on a different conversation
   * appends a `conversation_linked` event rather than moving this field.
   */
  conversationId: IdSchema.nullable(),
  contactId: IdSchema.nullable(),
  /**
   * Null on an auto-created ticket (TAR-21): the first inbound message is as
   * likely to be an image or a sticker as a sentence, so there is nothing
   * honest to derive a subject from. Clients fall back to the contact's name.
   */
  subject: z.string().min(1).max(200).nullable(),
  status: TicketStatusSchema,
  priority: TicketPrioritySchema,
  assignedUserId: IdSchema.nullable(),
  assignedTeamId: IdSchema.nullable(),
  routing: TicketRoutingSchema,
  sla: TicketSlaSchema,
  firstRespondedAt: TimestampSchema.nullable(),
  resolvedAt: TimestampSchema.nullable(),
  closedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const TicketListQuerySchema = CursorPageQuerySchema.extend({
  status: TicketStatusSchema.optional(),
  priority: TicketPrioritySchema.optional(),
  scope: z.enum(['assigned', 'unassigned', 'all']).default('assigned'),
  assignedUserId: IdSchema.optional(),
  assignedTeamId: IdSchema.optional(),
  /**
   * The supervisor's stuck-ticket landing query is
   * `?scope=unassigned&routingState=deferred` — one indexed predicate against
   * `tickets_routing_deferred_idx`, rather than a new endpoint (TAR-274).
   */
  routingState: TicketRoutingStateSchema.optional(),
  /** Filters to tickets whose SLA has breached — the supervisor's landing view. */
  breachedOnly: z.boolean().default(false),
});

export const TicketUpdateInputSchema = z.object({
  subject: z.string().min(1).max(200).optional(),
  status: TicketStatusSchema.optional(),
  priority: TicketPrioritySchema.optional(),
});

export const TicketAssignInputSchema = z
  .object({
    userId: IdSchema.nullable().optional(),
    teamId: IdSchema.nullable().optional(),
    /** Recorded on the event log; surfaced in the escalation history (TAR-32). */
    reason: z.string().max(500).optional(),
  })
  .refine((v) => v.userId !== undefined || v.teamId !== undefined, {
    message: 'Provide at least one of userId or teamId',
  });

/**
 * Append-only audit trail. Every status change, assignment and SLA event lands
 * here, which is what makes TAR-32's escalation log and TAR-30's cycle-time
 * reporting derivable rather than separately maintained.
 */
export const TICKET_EVENT_TYPES = [
  'created',
  /**
   * A message arrived on a conversation other than the one this ticket was
   * opened from — only reachable when a tenant runs more than one WhatsApp
   * number for the same contact (TAR-73). Recorded rather than acted on, so
   * that if the one-active-ticket-per-contact assumption turns out to be wrong
   * for real tenants, the evidence is already in the log.
   */
  'conversation_linked',
  'status_changed',
  'priority_changed',
  'assigned',
  'unassigned',
  /**
   * Routing ran and nobody was eligible, so the ticket stayed unassigned
   * (0007's `deferred` branch). The event's `reason` is a
   * `FallbackAssignmentReason`, and it is the audit record of the deferral;
   * `routing.state` is what says the deferral is *still true*, which is what a
   * supervisor's list filters on. Both are written — an event records that
   * something happened, a column records that it has not been fixed.
   *
   * Additive with no migration: `ticket_events.type` is text precisely so later
   * stories add types without one.
   */
  'assignment_deferred',
  'first_response',
  'sla_breached',
  'reopened',
  'bot_handoff',
] as const;
export const TicketEventTypeSchema = z.enum(TICKET_EVENT_TYPES);

export const TicketEventSchema = z.object({
  id: IdSchema,
  ticketId: IdSchema,
  type: TicketEventTypeSchema,
  /** Null when the actor was automation rather than a person. */
  actorUserId: IdSchema.nullable(),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: TimestampSchema,
});

export type TicketPriority = z.infer<typeof TicketPrioritySchema>;
export type TicketRoutingState = z.infer<typeof TicketRoutingStateSchema>;
export type TicketRouting = z.infer<typeof TicketRoutingSchema>;
export type SlaState = z.infer<typeof SlaStateSchema>;
export type TicketSla = z.infer<typeof TicketSlaSchema>;
export type TicketResponse = z.infer<typeof TicketResponseSchema>;
export type TicketListQuery = z.infer<typeof TicketListQuerySchema>;
export type TicketUpdateInput = z.infer<typeof TicketUpdateInputSchema>;
export type TicketAssignInput = z.infer<typeof TicketAssignInputSchema>;
export type TicketEventType = z.infer<typeof TicketEventTypeSchema>;
export type TicketEvent = z.infer<typeof TicketEventSchema>;
