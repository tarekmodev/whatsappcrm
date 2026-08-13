import { z } from 'zod';
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

/**
 * Which moves an agent may make through `PATCH /tickets/{id}`, from (key) to
 * (value). ADR 0006 §2 decides the table; this is that table as code, so the
 * console disables the impossible options from the same constant the API refuses
 * them with rather than keeping a second copy of it.
 *
 * `resolved` and `closed` are terminal-for-active: there is no reopen window at
 * v1 (ADR 0003 open question 1), and `tickets_one_active_per_contact` would
 * refuse a re-activation anyway — messily, as an `internal_error` — whenever the
 * contact has since opened a new ticket. Refusing it in the service is the same
 * answer, correctly coded.
 *
 * A customer replying to a `pending` ticket still moves it back to `open`; that
 * is the system reopen, which does not go through this endpoint.
 */
export const TICKET_STATUS_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ['pending', 'resolved', 'closed'],
  pending: ['open', 'resolved', 'closed'],
  resolved: ['closed'],
  closed: [],
};

/**
 * True when an agent may make this move through `PATCH /tickets/{id}`.
 *
 * Setting the value a ticket already holds is included, and deliberately: a
 * double-clicked button and a retry after a dropped response both arrive as "set
 * resolved" on a ticket that is already resolved, and `PATCH` is defined by the
 * target state rather than by the delta. The endpoint answers 200 with the
 * current ticket and writes no event (ADR 0006 §2).
 */
export function canAgentTransition(from: TicketStatus, to: TicketStatus): boolean {
  return from === to || TICKET_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Statuses whose *entry* additionally requires `ticket:close` on top of
 * `ticket:update` (ADR 0006 §7). Both are in every role's set today, so no
 * behaviour changes; what it buys is that a later triage-only role can hold
 * `ticket:update` for priority without the right to finish somebody's work.
 */
export const TICKET_STATUS_REQUIRES_CLOSE: Record<TicketStatus, boolean> = {
  open: false,
  pending: false,
  resolved: true,
  closed: true,
};

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
  /** Filters to tickets whose SLA has breached — the supervisor's landing view. */
  breachedOnly: z.boolean().default(false),
});

/**
 * The one mutation surface for an agent-driven status, priority or subject
 * change (ADR 0006 §1). A body with nothing in it is `validation_failed` rather
 * than a no-op 200: `{}` is a client bug with no honest answer, and enforcing it
 * on the schema means no route has to remember.
 */
export const TicketUpdateInputSchema = z
  .object({
    subject: z.string().min(1).max(200).optional(),
    status: TicketStatusSchema.optional(),
    priority: TicketPrioritySchema.optional(),
  })
  .refine(
    (input) =>
      input.subject !== undefined || input.status !== undefined || input.priority !== undefined,
    { message: 'Provide at least one of subject, status or priority' },
  );

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
  'first_response',
  'sla_breached',
  'reopened',
  'bot_handoff',
] as const;
export const TicketEventTypeSchema = z.enum(TICKET_EVENT_TYPES);

/**
 * *What* moved the ticket, as opposed to *who* did (ADR 0006 §5). Kept out of
 * `reason`, which is agent-supplied free text surfaced in the escalation
 * history: a machine token in there would force every client to string-match.
 *
 * The distinction this exists for is `pending → open` after a customer replies.
 * That is a `status_changed` with `cause: 'inbound_message'` and a null actor —
 * *not* a `reopened` event, which stays reserved for the `resolved →` reopen
 * window of ADR 0003 open question 1 and is written by nothing at v1.
 */
export const TICKET_EVENT_CAUSES = ['agent', 'inbound_message', 'automation', 'sla'] as const;
export const TicketEventCauseSchema = z.enum(TICKET_EVENT_CAUSES);

export const TicketEventSchema = z.object({
  id: IdSchema,
  ticketId: IdSchema,
  type: TicketEventTypeSchema,
  /** Null when the actor was automation rather than a person. */
  actorUserId: IdSchema.nullable(),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  reason: z.string().nullable(),
  /** Null on an event written before the cause was published. */
  cause: TicketEventCauseSchema.nullable(),
  createdAt: TimestampSchema,
});

export type TicketPriority = z.infer<typeof TicketPrioritySchema>;
export type SlaState = z.infer<typeof SlaStateSchema>;
export type TicketSla = z.infer<typeof TicketSlaSchema>;
export type TicketResponse = z.infer<typeof TicketResponseSchema>;
export type TicketListQuery = z.infer<typeof TicketListQuerySchema>;
export type TicketUpdateInput = z.infer<typeof TicketUpdateInputSchema>;
export type TicketAssignInput = z.infer<typeof TicketAssignInputSchema>;
export type TicketEventType = z.infer<typeof TicketEventTypeSchema>;
export type TicketEventCause = (typeof TICKET_EVENT_CAUSES)[number];
export type TicketEvent = z.infer<typeof TicketEventSchema>;
