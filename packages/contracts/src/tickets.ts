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
   * The supervisor's stuck-ticket landing query is `?routingState=deferred` — one
   * indexed predicate against `tickets_routing_deferred_idx`, rather than a new
   * endpoint (TAR-274).
   *
   * An enum rather than a boolean, so it takes its value straight from the query
   * string and needs none of the coercion `breachedOnly` below documents.
   *
   * ⚠️ **`deferred` also changes the page's order**, to
   * `routingDeferredSince ASC, id ASC` — oldest stuck first, which is what ADR
   * 0008 decision 3 gives that column to the schema for (0008 amendment 3,
   * TAR-365). Every other value pages in the queue's own
   * `priority DESC, createdAt DESC, id DESC`. That makes the two shapes' cursors
   * incompatible **by arity**, which is deliberate: a deferred cursor carries one
   * sort value and a queue cursor carries two, so replaying one against the other
   * is `validation_failed` rather than a page from the wrong place.
   */
  routingState: TicketRoutingStateSchema.optional(),
  /**
   * Narrows the deferred queue to one reason, for the supervisor filter TAR-274
   * ships. Not in ADR 0008's Interfaces section and added deliberately: the ADR
   * gives the view a reason to render but no way to *ask* for one, and narrowing
   * a fetched page instead reports "no tickets for that reason" whenever the
   * matching ones sort past it — precisely the unstaffed night `none_available`
   * and `no_candidate_pool` exist to describe.
   *
   * Costs no index: an equality on `routing_deferred_reason` over the set
   * `tickets_routing_deferred_idx` already narrows to, which is small by
   * construction.
   *
   * **Pins the deferred set on its own**, so it selects the same oldest-first
   * order and cursor arity `routingState=deferred` does — a non-null reason is
   * equivalent to `routing_state = 'deferred'` under
   * `tickets_routing_deferred_consistent`, so there is no combination where this
   * parameter and that order could describe different sets.
   *
   * The console sends `?scope=all`, not `unassigned`: TAR-286 settled
   * `unassigned` as "no user **and** no team", but a ticket a rule routed to a
   * team and rotation then deferred still carries `assignedTeamId` — precisely
   * the `all_at_capacity` case the flagged queue exists to show.
   */
  deferredReason: FallbackAssignmentReasonSchema.optional(),
  /**
   * Filters to tickets whose SLA has breached — the supervisor's landing view.
   *
   * `stringbool`, not `boolean`, because this schema parses a **query string**:
   * `?breachedOnly=true` arrives as the four characters `true`, and `z.boolean()`
   * refuses it — so the one query the supervisor's landing view is built on
   * answered `validation_failed` for every value a client could send.
   *
   * Not `z.coerce.boolean()` either, and that one is worse than useless here:
   * coercion is `Boolean(value)`, so the non-empty string `"false"` is `true` and
   * `?breachedOnly=false` would turn the filter **on**. `stringbool` reads the
   * token — `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off` — and rejects
   * anything else rather than guessing.
   *
   * `limit` above takes `z.coerce.number()` for the same reason and gets away
   * with plain coercion because a number has no such trap.
   */
  breachedOnly: z.stringbool().default(false),
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
    /**
     * Recorded on the event log and surfaced in the ticket's history (TAR-32).
     *
     * Optional **here** and conditionally required by the service, because Zod
     * sees the body and the rule is about the row: see
     * `ticketAssignRequiresReason`. The floor and the trim are what stop the
     * empty string satisfying "present" and logging nothing.
     */
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .refine((v) => v.userId !== undefined || v.teamId !== undefined, {
    message: 'Provide at least one of userId or teamId',
  });

/**
 * True when `POST /tickets/{id}/assign` requires a `reason` (ADR 0011
 * decision 1).
 *
 * The rule is about the ticket's *current* state, not the request: a
 * reassignment is a write that takes work away from somebody, which is exactly
 * the case where the ticket already has a holder. A supervisor emptying the
 * flagged queue (ADR 0008 decision 3) is placing work nobody held — not a
 * handoff, and with no handoff to explain.
 *
 * Published as a predicate rather than described twice, the same shape as
 * `canAgentTransition` and `TICKET_STATUS_REQUIRES_CLOSE`: the console has to
 * know whether to mark the field required *before* it submits, and a second
 * copy that drifts is a form that refuses a submit the API would have accepted
 * — or, worse, offers one it will not.
 */
export function ticketAssignRequiresReason(ticket: {
  assignedUserId: string | null;
  assignedTeamId: string | null;
}): boolean {
  return ticket.assignedUserId !== null || ticket.assignedTeamId !== null;
}

/**
 * `POST /tickets/{id}/escalate` — raise attention, without moving the
 * assignment (ADR 0011 decision 3).
 *
 * `reason` is **unconditionally** required here. Unlike a placement there is no
 * escalation without something to escalate: the reason is the whole payload.
 *
 * `toUserId` names one supervisor when the agent knows who they need. Absent
 * means "whoever supervises this ticket", and recipients are derived the way
 * ADR 0006 already derives them for an SLA breach.
 */
export const TicketEscalateInputSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  /** A named supervisor. Absent means "whoever supervises this ticket". */
  toUserId: IdSchema.optional(),
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
   * An agent asked for supervisor attention (TAR-32, ADR 0011 decision 4). The
   * assignment does **not** move, so this is never an `assigned` event and the
   * two must stay distinguishable in the history.
   *
   * Additive with no migration: `ticket_events.type` is text precisely so later
   * stories add types without one.
   */
  'escalated',
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

/**
 * Both sides of an assignment change. Null on every event that is not one.
 *
 * A nested object rather than more scalar columns, matching the convention
 * `TicketRouting` and `TicketSla` already set: `fromValue`/`toValue` stay the
 * scalar pair they were built for (`status_changed`, `priority_changed`), and an
 * assignment moves up to four ids at once.
 */
export const TicketEventAssignmentSchema = z.object({
  fromUserId: IdSchema.nullable(),
  fromTeamId: IdSchema.nullable(),
  toUserId: IdSchema.nullable(),
  toTeamId: IdSchema.nullable(),
});

/**
 * One event on a ticket's append-only history.
 *
 * Per-type encoding, and this table is the contract a console renders from
 * (ADR 0011 decision 4):
 *
 * | `type`                | `fromValue`  | `toValue`                    | `assignment` | `reason`   |
 * | --------------------- | ------------ | ---------------------------- | ------------ | ---------- |
 * | `created`             | null         | null                         | null         | null       |
 * | `status_changed`      | old status   | new status                   | null         | null       |
 * | `priority_changed`    | old priority | new priority                 | null         | null       |
 * | `assigned`            | null         | null                         | **set**      | when given |
 * | `unassigned`          | null         | null                         | **set**      | when given |
 * | `escalated`           | null         | named supervisor, or null    | null         | **always** |
 * | `assignment_deferred` | null         | null                         | null         | the `FallbackAssignmentReason` |
 * | `sla_breached`        | null         | the `SlaTargetKind`          | null         | null       |
 *
 * `toValue` being null on an `escalated` event is meaningful rather than
 * missing: it says the escalation was addressed to whoever supervises this
 * ticket rather than to a person, and the two render differently.
 */
export const TicketEventSchema = z.object({
  id: IdSchema,
  ticketId: IdSchema,
  type: TicketEventTypeSchema,
  /** Null when the actor was automation rather than a person. */
  actorUserId: IdSchema.nullable(),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  /** Set on `assigned` and `unassigned`; null on every other type. */
  assignment: TicketEventAssignmentSchema.nullable(),
  reason: z.string().nullable(),
  /** Null for the event types that predate the token, and for `created`. */
  cause: TicketEventCauseSchema.nullable(),
  createdAt: TimestampSchema,
});

/**
 * `GET /tickets/{id}/events` — keyset paginated like every other list in this
 * API, because a busy ticket accumulates events indefinitely and an offset page
 * over an append-only log is the one shape that silently degrades.
 *
 * No `type` filter at v1: a ticket's history is short enough to read whole.
 */
export const TicketEventListQuerySchema = CursorPageQuerySchema;

/**
 * What `POST /tickets/{id}/escalate` answers.
 *
 * Not a `TicketResponse`: nothing on the ticket moved, so returning one would
 * tell the console nothing and hide the only fact it needs.
 */
export const TicketEscalationResponseSchema = z.object({
  event: TicketEventSchema,
  /**
   * Every recipient an alert row was written for.
   *
   * **Empty is a real outcome**, not an error — a tenant with no active
   * supervisor or admin gets it (ADR 0006 decision 4). The escalation is still
   * recorded, so the console says "recorded, but nobody was notified" rather
   * than showing a green tick or a failure the agent cannot fix.
   */
  notifiedUserIds: z.array(IdSchema),
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
export type TicketEscalateInput = z.infer<typeof TicketEscalateInputSchema>;
export type TicketEventType = z.infer<typeof TicketEventTypeSchema>;
export type TicketEventCause = (typeof TICKET_EVENT_CAUSES)[number];
export type TicketEventAssignment = z.infer<typeof TicketEventAssignmentSchema>;
export type TicketEvent = z.infer<typeof TicketEventSchema>;
export type TicketEventListQuery = z.infer<typeof TicketEventListQuerySchema>;
export type TicketEscalationResponse = z.infer<typeof TicketEscalationResponseSchema>;
