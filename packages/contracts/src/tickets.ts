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
 * Which moves an agent may make through `PATCH /tickets/{id}` (0006, §2).
 *
 * `resolved` and `closed` are terminal-for-active: nothing re-activates them.
 * Two reasons, and the first is load-bearing — `tickets_one_active_per_contact`
 * is a partial unique index over `status IN ('open','pending')`, and a contact
 * whose resolved ticket is re-activated may already hold a new active one, so
 * the UPDATE would raise a unique violation that reaches the client as
 * `internal_error`. Refusing here is the same answer, correctly coded. The
 * second: there is no reopen window at v1 (0003, open question 1), and adding
 * one through an agent-initiated PATCH would ship half of it.
 *
 * `open → closed` is allowed and does not pass through `resolved`. Closing spam
 * or a wrong number is not a resolution, and forcing the two-step would put a
 * fake `resolved_at` on every one of them.
 *
 * Published here rather than re-typed per surface: the console disables the
 * impossible options from this constant, which is the same argument `rbac.ts`
 * makes for permissions. A second copy that drifts is a UI offering a move the
 * API refuses.
 *
 * Note what it does **not** govern. The customer-reply reopen makes the same
 * `pending → open` move this table allows an agent, but it is written by
 * `TicketLinkerService` off the inbound-message queue, under a tenant and no
 * principal — it consults nothing here and no permission check applies to it.
 * This table is the *agent's* surface only.
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
 * `from === to` is **not** a transition and answers `false`. Setting the value a
 * ticket already has is a no-op the endpoint accepts (0006, §2) rather than a
 * move it validates, so the caller checks equality first and never reaches this.
 */
export function canAgentTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Entering these additionally requires `ticket:close` (0004, 0006 §7).
 *
 * Both `ticket:update` and `ticket:close` sit in `AGENT_PERMISSIONS` today, so
 * no role's behaviour changes on the day this lands. What it buys is that a
 * later triage-only role can hold `ticket:update` — to re-prioritise a queue —
 * without the right to finish somebody else's work.
 */
export const TICKET_STATUS_REQUIRES_CLOSE: Record<TicketStatus, boolean> = {
  open: false,
  pending: false,
  resolved: true,
  closed: true,
};

/**
 * Declaration order is **urgent-last on purpose**: `ticket_priority` is a
 * Postgres enum, Postgres orders one by declaration order, and the ticket queue
 * is `ORDER BY priority DESC` (0006, §6). Reordering this array — or the enum in
 * `schema.prisma` it mirrors — silently inverts the queue and puts `low` on top.
 * `ticket-queue.int-spec.ts` asserts `urgent` sorts before `low` so that a
 * reorder fails a test rather than a customer.
 */
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
 * The one mutation surface for an agent-driven ticket change (0006, §1). One
 * endpoint for all three fields, because a status change and a re-prioritisation
 * are one triage action an agent makes in one form — unlike a conversation's
 * status, which has its own sub-route.
 *
 * Every field optional, and **at least one required**. `{}` is a client bug with
 * no honest answer: accepting it as a 200 no-op would report success for a
 * request that asked for nothing. The refinement lives on the schema rather than
 * in a route so that no route has to remember it.
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
  /**
   * **Reserved, and not written by anything today** (0006, §5). It belongs to
   * the `resolved →` reopen window of 0003 open question 1, which does not exist
   * at v1.
   *
   * The customer-reply reopen — `pending → open` — is a `status_changed` with
   * `cause: 'inbound_message'`, which is what `TicketLinkerService` has written
   * since TAR-21 and what 0003's own transition table specifies. Two event types
   * meaning "the status moved" would make every consumer learn both, and TAR-30
   * derives cycle time from exactly that property. Spending the name now would
   * also leave the reopen window with nothing to add.
   */
  'reopened',
  'bot_handoff',
] as const;
export const TicketEventTypeSchema = z.enum(TICKET_EVENT_TYPES);

/**
 * What moved a ticket, as a machine token (0006, §5).
 *
 * Separate from `reason` rather than folded into it. `reason` is agent-supplied
 * free text surfaced in the escalation history (TAR-32); a token hidden in it
 * would force the console to string-match prose a human wrote.
 *
 * It is what distinguishes an agent reopening a ticket by hand from the customer
 * reopening it by replying — the two write the same `status_changed` and the
 * console renders `inbound_message` as "Reopened — customer replied".
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
  /** Null for the event types that predate the token, and for `created`. */
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
