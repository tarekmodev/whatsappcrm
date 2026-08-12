import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { TicketStatusSchema } from './tickets';

/**
 * The boundary between inbound conversation handling (TAR-20) and the ticket
 * module (TAR-21). Published by TAR-73 so TAR-75 can build and unit-test the
 * linking service before TAR-20's real pipeline exists.
 *
 * Full reasoning, alternatives and failure modes:
 * `docs/architecture/0003-ticket-auto-linking-contract.md`.
 *
 * **Why this file exists at all.** `ConversationsModule` and `TicketsModule` are
 * both L3 domain modules, and TAR-39's layering rule forbids a sideways import:
 * conversations may not import tickets. The two sides therefore share a shape,
 * not a class — this one — and meet over a queue.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** BullMQ queue owned by `TicketsModule`. */
export const TICKET_QUEUE = 'tickets';

/**
 * The job TAR-20's inbound processor enqueues for every **inbound** message,
 * after the message transaction has committed. Delivery is at-least-once and
 * the handler is idempotent, so a redelivery is a no-op rather than a duplicate
 * ticket.
 */
export const TICKET_ENSURE_JOB = 'ticket.ensure-for-message';

/**
 * The trigger payload. Deliberately five fields and no more: everything else a
 * consumer could want is reachable from `messageId` and `conversationId`, and a
 * wider payload is a wider thing to keep in step with the schema.
 *
 * The consumer re-reads the message through `TenantPrisma` rather than trusting
 * these values, because a queue payload is unauthenticated input and the read
 * has to happen in tenant scope anyway.
 */
export const InboundMessageTicketTriggerSchema = z.object({
  /** Resolved by ingest from `phone_number_id` → `whatsapp_accounts.tenant_id`. */
  tenantId: IdSchema,
  contactId: IdSchema,
  conversationId: IdSchema,
  messageId: IdSchema,
  /** The provider's `sent_at`, never insert order (TAR-39, ordering). */
  receivedAt: TimestampSchema,
});

export type InboundMessageTicketTrigger = z.infer<typeof InboundMessageTicketTriggerSchema>;

/**
 * Stable BullMQ `jobId`, so a webhook Meta retried — or one the sweeper
 * re-enqueued — collapses to a single job while the first is still queued.
 * This is an optimisation, not the correctness mechanism: BullMQ forgets a
 * completed job's id once it leaves the completed set, and the handler's own
 * idempotency is what actually prevents duplicates.
 *
 * Hyphens, never a colon — the rule `media-jobs.ts` and `webhook-jobs.ts`
 * already follow. BullMQ reserves `:` for its own Redis key structure and
 * rejects a custom id containing one, with a single backwards-compatibility
 * exemption for ids that split into exactly three parts. This id's first shape
 * (TAR-73) was legal only by landing on that exemption, which BullMQ's own
 * source marks `TODO` for removal. The rejection surfaces as one warning per
 * inbound message out of `QueueService.enqueue` rather than a throw, so the
 * failure mode was tickets silently not being created (TAR-249).
 *
 * Carries `tenantId` as well as `messageId` even though `messageId` alone is
 * unique: it is what makes one tenant's ensure-jobs filterable in a queue
 * dashboard while that triage is happening.
 */
export function ticketEnsureJobId(trigger: InboundMessageTicketTrigger): string {
  return `ticket-ensure-${trigger.tenantId}-${trigger.messageId}`;
}

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

/**
 * What the call did.
 *
 * `created` and `attached` both mean "this message now belongs to a ticket";
 * the distinction exists because only `created` emits `ticket.created` and only
 * `created` consumes a ticket number.
 */
export const TICKET_LINK_OUTCOMES = ['created', 'attached', 'skipped'] as const;
export const TicketLinkOutcomeSchema = z.enum(TICKET_LINK_OUTCOMES);

/**
 * The only reason a call is skipped rather than throwing. Skips are for states
 * that are *correct* and will never change on retry; everything else — a
 * message that is not visible yet, a database fault — throws so the job retries.
 */
export const TICKET_LINK_SKIP_REASONS = ['not_inbound'] as const;
export const TicketLinkSkipReasonSchema = z.enum(TICKET_LINK_SKIP_REASONS);

export const TicketLinkResultSchema = z.object({
  outcome: TicketLinkOutcomeSchema,
  /** Null only when `outcome` is `skipped`. */
  ticketId: IdSchema.nullable(),
  ticketNumber: z.int().positive().nullable(),
  /**
   * The ticket's status *before* this call. `pending` here means the customer
   * replied to a ticket that was waiting on them, which is TAR-26's cue to
   * resume a paused SLA timer. Null when `outcome` is `created` or `skipped`.
   */
  previousStatus: TicketStatusSchema.nullable(),
  reason: TicketLinkSkipReasonSchema.nullable(),
});

export type TicketLinkOutcome = z.infer<typeof TicketLinkOutcomeSchema>;
export type TicketLinkSkipReason = z.infer<typeof TicketLinkSkipReasonSchema>;
export type TicketLinkResult = z.infer<typeof TicketLinkResultSchema>;

/**
 * The one method TAR-20 reaches the ticket module through.
 *
 * **Idempotent by contract.** Calling it repeatedly for the same `messageId`
 * yields the same ticket and at most one `created`. Concurrent calls for the
 * same contact yield exactly one `created` and the rest `attached` — enforced
 * by a partial unique index, not by application checking.
 *
 * **Never throws a race.** A conflict on the create path is resolved internally
 * by re-reading and attaching. A caller only sees an error when something is
 * genuinely wrong.
 *
 * Implemented by TAR-75; the concrete class lives in `apps/api/src/tickets`.
 */
export interface TicketLinker {
  ensureTicketForMessage(trigger: InboundMessageTicketTrigger): Promise<TicketLinkResult>;
}

/**
 * Nest injection token. `TicketsModule` provides it; the job processor consumes
 * it. Kept here so neither side has to import the other's class to name it.
 */
export const TICKET_LINKER = Symbol.for('whatsappcrm.TicketLinker');
