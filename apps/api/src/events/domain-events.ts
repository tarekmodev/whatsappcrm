import type {
  MediaDownloadState,
  MessageContentType,
  MessageDirection,
  MessageStatus,
  TicketPriority,
  TicketStatus,
} from '../generated/prisma/enums';

/**
 * The in-process domain event bus (`@nestjs/event-emitter`, TAR-39: "two event
 * buses, chosen by durability"). Everything here is same-request fan-out where
 * loss is acceptable — a socket relay, a cache bust. Anything that must survive
 * a restart goes on BullMQ instead.
 *
 * These shapes live outside every feature module on purpose. `WebhooksModule`
 * (L2) emits them and `RealtimeModule` (L1) subscribes; the layering rule
 * forbids either importing the other, so what they share is a type, not a class.
 *
 * **Not an API contract.** The socket payload is a full `MessageResponse` from
 * `@whatsappcrm/contracts` (TAR-39, realtime: "payloads are whole resources").
 * These carry what the emitter already has in hand so the subscriber can build
 * that response without a second round trip, and may change with the schema.
 */

export const SESSIONS_REVOKED_EVENT = 'sessions.revoked';
export const MESSAGE_CREATED_EVENT = 'message.created';
export const MESSAGE_STATUS_CHANGED_EVENT = 'message.status_changed';
export const MESSAGE_ATTACHMENT_SETTLED_EVENT = 'message.attachment_settled';
export const TICKET_CREATED_EVENT = 'ticket.created';
export const TICKET_UPDATED_EVENT = 'ticket.updated';
export const CONVERSATION_ASSIGNED_EVENT = 'conversation.assigned';
export const SLA_BREACHED_EVENT = 'sla.breached';

/**
 * Something happened that may have ended one or more of this user's sessions —
 * a sign-out, a logout-everywhere, a password change or reset, a suspension, a
 * role change, a team membership change.
 *
 * Emitted **after** the transaction commits, from the one after-commit hook
 * every revocation path already has to call (`SessionService.purgeCacheFor`), so
 * there is one producer rather than one per reason.
 *
 * ## It says "re-check", not "disconnect"
 *
 * Deliberately carries no session ids. That hook is documented as safe to call
 * unconditionally — including after a transaction that revoked nothing — so an
 * event meaning "these sessions are dead" would sometimes be a lie, and a
 * subscriber acting on it would drop live connections. A subscriber instead
 * re-reads each of that user's sessions and acts on what the database says,
 * which is correct for the no-op case and costs one indexed read per socket on
 * an operation that happens a few times a month per tenant.
 *
 * On the in-process bus because the consumer is the realtime relay, and because
 * loss is acceptable in the way that matters: nothing about *authorisation*
 * depends on this. A missed event leaves a socket connected that no longer
 * receives anything it may not see — every emit is addressed by the audience
 * rooms, and the revoked principal's next HTTP request is refused regardless.
 * What it buys is the tab noticing, which is TAR-56's fifth acceptance criterion
 * reaching the one surface that outlives a request.
 */
export interface SessionsRevokedEvent {
  readonly tenantId: string;
  readonly userId: string;
}

/**
 * A message row that did not exist before — inbound from a webhook, or the
 * placeholder a status webhook creates when it overtakes the message it
 * describes.
 */
export interface MessageCreatedEvent {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly contactId: string;
  readonly messageId: string;
  readonly direction: MessageDirection;
  readonly status: MessageStatus;
  readonly contentType: MessageContentType;
  readonly body: string | null;
  readonly providerMessageId: string | null;
  /** The provider's timestamp, never insert order (TAR-39, ordering). */
  readonly sentAt: Date;
}

/**
 * An existing message whose status moved **forward**. A status webhook that does
 * not advance the ladder is applied to nothing and emits nothing, so a late
 * `sent` never reaches a client as an un-read.
 */
export interface MessageStatusChangedEvent {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly status: MessageStatus;
  /**
   * Meta's id, or `null` when there is not one yet.
   *
   * Null is the outbound send path's case (TAR-68): a message that Meta refused
   * moves `queued → failed` without ever being given an id, and that transition
   * is exactly the one an agent has to see. Non-null for every transition a
   * status webhook drives, because the webhook is matched on it.
   */
  readonly providerMessageId: string | null;
}

/**
 * An inbound attachment stopped being `pending` — the bytes are re-hosted, or
 * they never will be.
 *
 * Emitted because the download runs off the ingest path (TAR-20e), so
 * `message.created` reaches the inbox with `url: null` and a spinner. Without a
 * second event the spinner is permanent until the agent reloads: nothing else
 * that happens to that message would ever mention its attachment.
 *
 * Both outcomes are published, not just the happy one. "It failed" is what
 * turns the spinner into something the agent can act on — and a `failed`
 * attachment is a support conversation, not a silent gap.
 *
 * `url` is a path, as the column holds it. The subscriber makes it absolute
 * against the request or socket origin, the same way the message mapper does.
 */
export interface MessageAttachmentSettledEvent {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly attachmentId: string;
  readonly downloadState: MediaDownloadState;
  readonly url: string | null;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
}

/**
 * A ticket that did not exist before — auto-created by `TicketLinker` for an
 * inbound message from a contact who had no active ticket (TAR-21). Emitted on
 * the `created` path only: attaching to a ticket that already exists is not a
 * new ticket, and a subscriber that treated it as one would assign or start an
 * SLA timer twice.
 *
 * Emitted **after** the transaction commits, like every event here — pushing a
 * ticket to an agent's screen that a rollback then un-wrote is worse than
 * pushing it a few milliseconds later.
 *
 * On the in-process bus because its first consumer is the realtime relay:
 * decision 1 of 0003 accepts that a ticket is eventually consistent with the
 * message that created it, and this event is what closes that gap in the inbox
 * without a refetch. A subscriber for which loss is *not* acceptable — TAR-23's
 * assignment, TAR-26's SLA timers — needs a durable trigger of its own rather
 * than this one, and owns that decision.
 */
export interface TicketCreatedEvent {
  readonly tenantId: string;
  readonly ticketId: string;
  /** Per-tenant, human-facing number — what an agent quotes. */
  readonly ticketNumber: number;
  readonly contactId: string;
  /** The conversation the ticket was opened from. */
  readonly conversationId: string;
}

/**
 * A ticket an agent changed through `PATCH /api/v1/tickets/{id}` — its status,
 * its priority or its subject (TAR-25).
 *
 * Emitted **after** the transaction commits, like everything here, and only when
 * a column actually moved: a request setting a ticket to the status it already
 * holds writes nothing and announces nothing.
 *
 * ## Nothing subscribes yet, and that is the decision rather than the gap
 *
 * `realtime.ts` already publishes a `ticket.updated` server event carrying a
 * whole `TicketResponse`. TAR-25 deliberately does not connect the two: a
 * ticket's audience is `isVisible` as rooms, which is **not**
 * `conversationAudienceRooms` — there is no unclaimed branch, and the readers
 * room would have to be a ticket one keyed to `ticket:read_all` rather than
 * `conversation:read_all`. That is a rooms amendment, and a rooms amendment
 * reviewed under a status-change story is how an authorization bypass ships.
 * The console refetches on view and after its own mutation instead; an
 * auto-reopen becomes visible on the next refetch.
 *
 * This event exists so that relay is a subscriber away rather than a rewrite.
 *
 * ## The system reopen does not emit it
 *
 * `TicketLinkerService` moves a `pending` ticket to `open` on the customer's
 * reply and stays silent, as it has since TAR-21 — its own path already emits
 * `ticket.created` for the case a subscriber must not miss. Adding a second
 * producer here would mean auditing that path's after-commit shape under a story
 * whose realtime answer is "refetch". Recorded so the asymmetry is a decision a
 * reader can see rather than one they have to infer.
 *
 * Both priority fields are carried even though a subscriber that re-reads the
 * row can see the current one: a client deciding whether a queue needs
 * re-sorting cares whether the *band* moved, and that is not recoverable after
 * the write.
 */
export interface TicketUpdatedEvent {
  readonly tenantId: string;
  readonly ticketId: string;
  readonly previousStatus: TicketStatus;
  readonly status: TicketStatus;
  readonly previousPriority: TicketPriority;
  readonly priority: TicketPriority;
  /** Null when the writer was the system — the reopen path, which does not emit today. */
  readonly actorUserId: string | null;
}

/**
 * A conversation changed hands (TAR-198): claimed from the shared pool, released
 * back into it, handed to another agent, or routed to a team.
 *
 * Emitted from `POST /conversations/{id}/assign` **only when a column actually
 * moved**. An assign that names the current owner again has changed nothing, and
 * relaying it would be a broadcast that says nothing.
 *
 * ## It carries the assignment the thread *had*, and nothing about the one it has
 *
 * The subscriber reads the row back for its payload, so the new owner needs no
 * field here — and reading it is what makes the published resource the committed
 * one rather than the writer's view of it. The previous assignment is the one
 * thing the subscriber cannot recover after the write, and it is the whole reason
 * this event exists: a conversation's audience is derived from its assignment
 * (`conversationAudienceRooms`), so the moment an agent claims a thread the
 * colleagues who were watching it unclaimed are in none of the rooms it now
 * addresses. Without the assignment it had, "somebody else has this" reaches
 * everybody except the people it is for.
 *
 * On the in-process bus, like everything here: a missed relay costs a client one
 * refetch, and the row is already committed. Nothing about authorization depends
 * on it — every emit is addressed by the rooms the *current* assignment implies.
 */
export interface ConversationAssignedEvent {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly previousAssignedUserId: string | null;
  readonly previousAssignedTeamId: string | null;
}

/**
 * A ticket missed its SLA deadline, and the supervisor alerts for it are
 * committed (TAR-26, 0006 decision 5).
 *
 * Emitted by the breach sweep **after** its per-tenant transaction commits, once
 * per breached timer, and only when at least one `sla_alerts` row was actually
 * inserted. A breach in a tenant with nobody to tell emits nothing — there is no
 * audience to address, and the ticket's overdue badge is served by the queue.
 *
 * ## Why loss is acceptable here, unlike the trigger that leads to it
 *
 * The four *inputs* to the SLA mechanism are durable BullMQ jobs precisely
 * because losing one loses a timer. This is the opposite direction: by the time
 * it is emitted, the row that makes "the supervisor is notified" true is already
 * committed, and a supervisor who was offline sees it on their next
 * `GET /api/v1/sla-alerts`. The socket is an accelerator, so a missed relay
 * costs one page load — which is exactly what this bus is for.
 *
 * ## It carries ids, not resources
 *
 * The subscriber reads both back, for the same reason `conversation.assigned`
 * does: the payload a socket publishes must be the committed resource rather
 * than the writer's view of it, and the `ticket.updated` half is addressed by
 * the assignment on the row that read returns.
 */
export interface SlaBreachedEvent {
  readonly tenantId: string;
  readonly ticketId: string;
  /** The alert rows this breach inserted. One socket per id, and no more. */
  readonly alertIds: readonly string[];
}
