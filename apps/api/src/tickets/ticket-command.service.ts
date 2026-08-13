import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  SLA_EVALUATE_TICKET_JOB,
  SLA_QUEUE,
  TICKET_STATUS_REQUIRES_CLOSE,
  canAgentTransition,
  type SlaEvaluateTicketTrigger,
  type TicketPriority,
  type TicketResponse,
  type TicketStatus,
  type TicketUpdateInput,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TICKET_UPDATED_EVENT, type TicketUpdatedEvent } from '../events/domain-events';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { QueueService } from '../queue/queue.service';
import { TICKET_PROJECTION, toTicketResponse, type TicketRow } from './ticket.mapper';
import { TicketQueryService } from './ticket-query.service';
import {
  TicketCloseNotPermittedError,
  TicketStatusChangedConcurrentlyError,
  TicketTransitionNotAllowedError,
} from './tickets.errors';

/** Everything an agent-driven change writes, recorded as `agent` on the event log. */
const AGENT_CAUSE = 'agent';

/** What a request actually moves, after the current row has been read. */
interface TicketChange {
  readonly status: TicketStatus | null;
  readonly priority: TicketPriority | null;
  readonly subject: string | null;
}

/**
 * `PATCH /api/v1/tickets/{id}` — the one write an agent makes to a ticket
 * (TAR-25, ruled by 0006).
 *
 * Assignment (`POST /tickets/{id}/assign`, TAR-23) is not here and neither is
 * the event log read (TAR-32); both are additive when they land.
 *
 * ## Every path goes through `TicketQueryService.require` first
 *
 * So the visibility rule is applied exactly once and this route cannot be the
 * one that forgets it. A ticket the principal may not see answers `not_found`
 * here as it does on the read — never `forbidden`, which would confirm the id
 * names a real ticket a colleague holds.
 *
 * ## The write is a compare-and-set on `status`, and that is the rule to review
 *
 * A second writer touches these same rows: `TicketLinkerService`, off the
 * inbound-message queue, moving a `pending` ticket to `open` when the customer
 * replies. The two never meet in code and share no service. What keeps them
 * consistent is that **both express their write as
 * `updateMany … WHERE status = <the status read moments ago>`** — optimistic
 * concurrency on `status` itself, with no version column, because `status` *is*
 * the state the transition rules are about.
 *
 * Two orderings, both consistent:
 *
 *   * the agent's `pending → resolved` commits first, so the linker's update
 *     matches nothing, writes no event, and — its earlier active-ticket read
 *     having found none — it **creates a new ticket** for the reply. That is
 *     0003's designed no-reopen-window behaviour, not a defect;
 *   * the reopen commits first, so the agent's update matches nothing and the
 *     request answers `conflict`.
 *
 * **A lost compare-and-set is never retried against the new status.**
 * Re-applying "resolve" from `open` would satisfy the agent's click and hide the
 * fact that the customer *just replied* — the one thing they need to know before
 * resolving.
 *
 * The guard is on `status` even for a request that only moves `priority` or
 * `subject`. One rule rather than two: the cost is a rare false conflict when a
 * customer's reply lands in the same instant as a re-prioritisation, and in that
 * instant the reply is what the agent should be looking at anyway.
 *
 * ## Not audited, deliberately
 *
 * `audit_logs` carries security-relevant events. Resolving a ticket or bumping
 * its priority is ordinary operational activity that happens hundreds of times a
 * day per tenant, and writing it there would drown the trail an auditor reads —
 * the same rule `ConversationCommandService` states. `ticket_events` is the
 * per-ticket history.
 */
@Injectable()
export class TicketCommandService {
  private readonly logger = new Logger(TicketCommandService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tickets: TicketQueryService,
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    private readonly queue: QueueService,
  ) {}

  /**
   * One transaction: compare-and-set the row, append one event per changed
   * field, and read the response projection back — so a mutation and a read of
   * the same ticket cannot publish different shapes.
   *
   * ## Setting the value it already has is a no-op, not a conflict
   *
   * A request whose `status` or `priority` equals the current value returns 200
   * with the current ticket, writes nothing, and appends no event. A
   * double-clicked button and a retry after a dropped response both arrive as
   * "set resolved" on a ticket that is already resolved, and answering 409 would
   * show the agent a failure for a request that achieved exactly what they
   * asked. `PATCH` is defined by the target state, not by the delta — and the
   * repo already ruled this shape once, in `ConversationCommandService.claim`.
   *
   * This is 0006 §2 overriding the wording of TAR-284's fifth acceptance
   * criterion. The rest of it stands: a transition the table refuses is refused
   * with a coded error, never silently accepted.
   */
  async update(ticketId: string, input: TicketUpdateInput): Promise<TicketResponse> {
    const before = await this.tickets.require(ticketId);
    const change = changesIn(before, input);

    if (change.status !== null) {
      this.assertTransitionAllowed(ticketId, before.status, change.status);
    }

    if (change.status === null && change.priority === null && change.subject === null) {
      return toTicketResponse(before);
    }

    const after = await this.write(before, change);

    this.announceUpdate(before, after);
    await this.triggerSlaEvaluation(before, after);

    return toTicketResponse(after);
  }

  /**
   * 0006's fourth SLA trigger: a ticket's status changed, so its timers may need
   * to pause, resume, stop or be cancelled (TAR-26).
   *
   * **A durable queue job, not the `ticket.updated` event this service already
   * emits.** `domain-events.ts` says it in as many words — "a subscriber for
   * which loss is not acceptable — TAR-23's assignment, TAR-26's SLA timers —
   * needs a durable trigger of its own." A missed in-process event costs a
   * client one refetch; a missed SLA transition leaves a paused clock running
   * against an agent for time they could not act on, or a breach nobody is told
   * about, with nothing anywhere recording that it was lost.
   *
   * Only a **status** change enqueues. A priority or subject edit moves no timer:
   * a running deadline keeps the policy it started under, which is 0006's rule
   * that a policy change affects future tickets and never past deadlines.
   *
   * `SlaModule` is L4 and this is L3, so what crosses the line is the shape in
   * `@whatsappcrm/contracts/sla` and a queue name — never an import.
   *
   * After the commit and never inside it: a job that reached a worker before the
   * status landed would reconcile against the old row and burn a retry. Failure
   * to enqueue is logged rather than thrown, per `QueueService`'s contract — the
   * status change is committed and the caller is owed their 200.
   */
  private async triggerSlaEvaluation(before: TicketRow, after: TicketRow): Promise<void> {
    if (before.status === after.status) {
      return;
    }

    const trigger: SlaEvaluateTicketTrigger = {
      tenantId: this.tenantContext.requireTenantId(),
      ticketId: after.id,
      reason: 'status_changed',
    };

    const outcome = await this.queue.enqueue<SlaEvaluateTicketTrigger>(
      SLA_QUEUE,
      SLA_EVALUATE_TICKET_JOB,
      trigger,
      {
        // No custom `jobId` — see the note in `@whatsappcrm/contracts/sla`.
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Ticket ${after.id} moved ${before.status} → ${after.status} but its SLA evaluation was ` +
          `not queued (${outcome}); its timers will not move until it is evaluated again.`,
      );
    }
  }

  /**
   * Two refusals, in this order.
   *
   * The transition table first, because it is a property of the row rather than
   * of the caller: telling somebody they need `ticket:close` for a move nobody
   * can make would send them after a permission that would not help.
   */
  private assertTransitionAllowed(ticketId: string, from: TicketStatus, to: TicketStatus): void {
    if (!canAgentTransition(from, to)) {
      throw new TicketTransitionNotAllowedError(ticketId, from, to);
    }

    if (
      TICKET_STATUS_REQUIRES_CLOSE[to] &&
      !this.tenantContext.requirePrincipal().permissions.includes('ticket:close')
    ) {
      throw new TicketCloseNotPermittedError(to);
    }
  }

  /**
   * The row and its event log, in one transaction.
   *
   * `updateMany` rather than `update` because the `WHERE` carries the
   * compare-and-set; `update` addresses the primary key alone and would happily
   * overwrite a status that moved underneath it. Zero rows matched is the race,
   * and the transaction rolls back with no event written — the log never claims
   * a transition that did not happen.
   *
   * `tenantId` is supplied explicitly here, unlike everywhere else in this
   * module: `$tenantTransaction` hands back the **un-extended** client, so the
   * per-statement policy that normally injects nothing and lets RLS filter is
   * not in play. RLS still applies — the GUC is set for the whole transaction —
   * and `ticket_events.tenant_id` is a `NOT NULL` column that has to be written
   * regardless.
   */
  private async write(before: TicketRow, change: TicketChange): Promise<TicketRow> {
    const tenantId = this.tenantContext.requireTenantId();
    const actorUserId = this.tenantContext.requirePrincipal().userId;

    return this.prisma.$tenantTransaction(async (tx) => {
      const { count } = await tx.ticket.updateMany({
        where: { tenantId, id: before.id, status: before.status },
        data: toUpdateData(change),
      });

      if (count === 0) {
        throw new TicketStatusChangedConcurrentlyError(before.id, before.status);
      }

      if (change.status !== null) {
        await tx.ticketEvent.create({
          data: {
            tenantId,
            ticketId: before.id,
            type: 'status_changed',
            actorUserId,
            data: { from: before.status, to: change.status, cause: AGENT_CAUSE },
          },
        });
      }

      if (change.priority !== null) {
        await tx.ticketEvent.create({
          data: {
            tenantId,
            ticketId: before.id,
            type: 'priority_changed',
            actorUserId,
            data: { from: before.priority, to: change.priority, cause: AGENT_CAUSE },
          },
        });
      }

      // `subject` writes no event, per 0006 §1: it is a label with no
      // transition rules and no consumer in the escalation history.
      return tx.ticket.findUniqueOrThrow({ where: { id: before.id }, select: TICKET_PROJECTION });
    });
  }

  /**
   * Tells the in-process bus a ticket changed, **after** the transaction has
   * committed — pushing a change that a rollback then un-wrote is the failure
   * every other producer of these events avoids the same way.
   *
   * Nothing subscribes yet. TAR-25 deliberately does not wire the socket relay:
   * `realtime.ts` already publishes a `ticket.updated` server event, but
   * addressing it needs a ticket-specific audience room — the conversation
   * readers room is keyed to a different permission — and a rooms amendment
   * reviewed under a status-change story is how an authorization bypass gets
   * shipped. The console refetches on view and after its own mutation; an
   * auto-reopen becomes visible on the next refetch. This event is what makes
   * the relay a subscriber away rather than a rewrite.
   *
   * Emitted for a subject-only change too. The subscriber's payload is the whole
   * resource, so "what moved" is not the event's job — that a ticket the client
   * is showing is now stale is.
   */
  private announceUpdate(before: TicketRow, after: TicketRow): void {
    const event: TicketUpdatedEvent = {
      tenantId: this.tenantContext.requireTenantId(),
      ticketId: after.id,
      previousStatus: before.status,
      status: after.status,
      previousPriority: before.priority,
      priority: after.priority,
      actorUserId: this.tenantContext.requirePrincipal().userId,
    };

    this.events.emit(TICKET_UPDATED_EVENT, event);
  }
}

/**
 * What the request actually moves, as three nullable fields — `null` meaning
 * "not this one", for a field that was absent *and* for one set to the value the
 * row already holds.
 *
 * Collapsing those two cases is the point: the rest of this service only ever
 * asks "did this move", and a shape that distinguished absent from unchanged
 * would invite a caller to write an event for the second.
 */
function changesIn(before: TicketRow, input: TicketUpdateInput): TicketChange {
  return {
    status: input.status === undefined || input.status === before.status ? null : input.status,
    priority:
      input.priority === undefined || input.priority === before.priority ? null : input.priority,
    subject: input.subject === undefined || input.subject === before.subject ? null : input.subject,
  };
}

/**
 * The columns to write, including the two timestamps a transition implies.
 *
 * ## `resolvedAt` and `closedAt` are written on the transition *into* a state
 *
 * Never derived from the state, and never cleared (0006, §3):
 *
 *   * `open`/`pending` → `resolved` sets `resolvedAt`, leaves `closedAt` null;
 *   * `resolved` → `closed` sets `closedAt` and leaves `resolvedAt` **alone**,
 *     so the ticket keeps the time it was actually resolved;
 *   * `open`/`pending` → `closed` sets `closedAt` and leaves `resolvedAt`
 *     **null**, deliberately. Closing spam or a wrong number is not a
 *     resolution, and back-filling one would manufacture a resolution that never
 *     happened — TAR-30's cycle-time reporting reads this column, and
 *     `closed_at IS NOT NULL AND resolved_at IS NULL` is the honest signal for
 *     "closed unworked".
 *
 * Re-resolving cannot overwrite: `resolved → resolved` is the no-op above and
 * `resolved → open` is refused, so there is no path back into `resolved` at v1
 * and the value is written exactly once. When a reopen window lands, the rule to
 * add is one line — entering `resolved` again overwrites.
 *
 * From the application clock, like every other timestamp Prisma writes here. The
 * raw `now()` in the linker's create is there because that statement bypasses
 * the client, not because the app clock is unacceptable; a resolution time does
 * not care about a few milliseconds of skew.
 */
function toUpdateData(change: TicketChange): Prisma.TicketUncheckedUpdateInput {
  const now = new Date();

  return {
    ...(change.status === null ? {} : { status: change.status }),
    ...(change.priority === null ? {} : { priority: change.priority }),
    ...(change.subject === null ? {} : { subject: change.subject }),
    ...(change.status === 'resolved' ? { resolvedAt: now } : {}),
    ...(change.status === 'closed' ? { closedAt: now } : {}),
  };
}
