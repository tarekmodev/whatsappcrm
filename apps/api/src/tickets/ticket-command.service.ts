import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  SLA_EVALUATE_TICKET_JOB,
  SLA_QUEUE,
  TICKET_STATUS_REQUIRES_CLOSE,
  canAgentTransition,
  type SlaEvaluateTicketTrigger,
  type TicketAssignInput,
  type TicketPriority,
  type TicketResponse,
  type TicketRoutingState,
  type TicketStatus,
  type TicketUpdateInput,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TICKET_UPDATED_EVENT, type TicketUpdatedEvent } from '../events/domain-events';
import type { Prisma } from '../generated/prisma/client';
import { UserStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { QueueService } from '../queue/queue.service';
import { TICKET_PROJECTION, toTicketResponse, type TicketRow } from './ticket.mapper';
import { TicketQueryService } from './ticket-query.service';
import {
  TicketCloseNotPermittedError,
  TicketNotFoundError,
  TicketStatusChangedConcurrentlyError,
  TicketTransitionNotAllowedError,
  UnknownTicketAssigneeError,
} from './tickets.errors';

/** Everything an agent-driven change writes, recorded as `agent` on the event log. */
const AGENT_CAUSE = 'agent';

/** What a request actually moves, after the current row has been read. */
interface TicketChange {
  readonly status: TicketStatus | null;
  readonly priority: TicketPriority | null;
  readonly subject: string | null;
}

/** Who holds the ticket once an assign body has been applied to the current row. */
interface TicketAssignment {
  readonly assignedUserId: string | null;
  readonly assignedTeamId: string | null;
}

/**
 * The two writes into a ticket: the agent's `PATCH /api/v1/tickets/{id}`
 * (TAR-25, ruled by 0006) and the supervisor's
 * `POST /api/v1/tickets/{id}/assign` (TAR-23, ruled by 0008 decision 3).
 *
 * The event log read (TAR-32) is not here and is additive when it lands.
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
 * `audit_logs` carries security-relevant events. Resolving a ticket, bumping its
 * priority or handing it to a colleague is ordinary operational activity that
 * happens hundreds of times a day per tenant, and writing it there would drown
 * the trail an auditor reads — the same rule `ConversationCommandService`
 * states. `ticket_events` is the per-ticket history, and the assign write
 * appends to it.
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
   * `POST /api/v1/tickets/{id}/assign` — the supervisor putting a name on a
   * ticket rotation could not place (0008 decision 3, amendment 2).
   *
   * ## Partial, like the conversation's assign
   *
   * `userId` and `teamId` are each applied only when the body carries them, so
   * one call can move a ticket from an agent to a team, hand it to a named agent
   * inside a team, or release it — without a route per direction. Absent leaves
   * the column alone, `null` clears it, an id sets it.
   *
   * ## The routing columns move with the assignment, in one statement
   *
   * `tickets_routing_deferred_consistent` requires `routing_deferred_reason` and
   * `routing_deferred_since` to be non-null **exactly** when
   * `routing_state = 'deferred'`, so a deferred ticket cannot leave that state
   * without both being nulled in the same write. That makes the four columns one
   * indivisible change rather than a preference, and it is why the event is
   * appended inside the same transaction: a log claiming an assignment the
   * constraint then rejected would be worse than no log.
   *
   * ## An explicit release goes to `pending`, not `manual`
   *
   * 0008 amendment 2. A body that leaves the ticket with neither a user nor a
   * team returns it to the state a fresh ticket has: nobody holds it, and no
   * supervisor has judged it stuck. `manual` would say "a human owns this
   * decision" about a ticket no human is on, and `deferred` would put a
   * deliberate release in the queue of things rotation failed to place — two
   * different events that must not read the same.
   *
   * **So `pending` is reachable after the insert.** It is not an insert-only
   * value, whatever the column default suggests; `ticket-query.service.ts`'s
   * `routingState` filter and the CHECK constraint both accept it, and a reader
   * who assumes otherwise is the one this paragraph is for.
   *
   * ## Last writer wins, deliberately
   *
   * No compare-and-set. `update` above guards on `status` because a *second
   * writer* — the linker's reopen — touches the same column off a queue; nothing
   * writes the assignment columns behind this route except the router, and the
   * router only ever moves a ticket **out of** unassigned. Two supervisors
   * assigning the same flagged ticket in the same second is a race whose honest
   * answer is "the later one holds it", and it is on the event log either way.
   *
   * ## Nothing is announced and nothing is enqueued
   *
   * No `ticket.updated`: that event carries status and priority, neither of which
   * moved, and 0008's Realtime section is explicit that pushing a routing change
   * is not in this story — TAR-274's view refetches. No SLA job either: 0006's
   * fourth trigger is a **status** change, and a timer does not move because the
   * ticket changed hands.
   */
  async assign(ticketId: string, input: TicketAssignInput): Promise<TicketResponse> {
    const before = await this.tickets.require(ticketId);

    await this.assertAssigneesExist(input);

    const assignment = assignmentAfter(before, input);

    if (!movesAnything(before, assignment)) {
      return toTicketResponse(before);
    }

    return toTicketResponse(await this.writeAssignment(before, assignment, input.reason));
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
   * The four assignment and routing columns and the one event, in one
   * transaction — the indivisibility the CHECK constraint imposes, and the
   * ordering that stops the log claiming an assignment that did not commit.
   *
   * `updateMany` rather than `update` for the reason `write` above gives:
   * `$tenantTransaction` hands back the **un-extended** client, so `tenantId` is
   * named explicitly here. It is a filter and not a compare-and-set — the row
   * was admitted by `require` moments ago, so zero rows matched means it was
   * deleted underneath the request, which is `not_found` and not a conflict.
   *
   * `previousAssignedUserId` and `previousAssignedTeamId` go on the event beside
   * the new pair: the router's `assigned` event omits them because it only ever
   * assigns a ticket nobody holds, but a supervisor's re-assignment is exactly
   * the case where "who had it before" is the interesting half, and TAR-32's
   * `fromValue` has to come from somewhere.
   */
  private async writeAssignment(
    before: TicketRow,
    assignment: TicketAssignment,
    reason: string | undefined,
  ): Promise<TicketRow> {
    const tenantId = this.tenantContext.requireTenantId();
    const actorUserId = this.tenantContext.requirePrincipal().userId;

    return this.prisma.$tenantTransaction(async (tx) => {
      const { count } = await tx.ticket.updateMany({
        where: { tenantId, id: before.id },
        data: {
          ...assignment,
          routingState: routingStateFor(assignment),
          routingDeferredReason: null,
          routingDeferredSince: null,
        },
      });

      if (count === 0) {
        throw new TicketNotFoundError(before.id);
      }

      await tx.ticketEvent.create({
        data: {
          tenantId,
          ticketId: before.id,
          type: hasAssignee(assignment) ? 'assigned' : 'unassigned',
          // A person did this, unlike the router's system-null actor.
          actorUserId,
          data: {
            ...assignment,
            previousAssignedUserId: before.assignedUserId,
            previousAssignedTeamId: before.assignedTeamId,
            cause: AGENT_CAUSE,
            ...(reason === undefined ? {} : { reason }),
          } satisfies Prisma.InputJsonObject,
        },
      });

      return tx.ticket.findUniqueOrThrow({ where: { id: before.id }, select: TICKET_PROJECTION });
    });
  }

  /**
   * Refuses an assignee this tenant does not have, or one that cannot take work.
   *
   * Both lookups go through `TenantPrisma`, so RLS supplies the tenant equality
   * and an id belonging to another tenant simply is not there — the id in the
   * body is never trusted as a key. Without this the foreign key would refuse it
   * anyway, but as a driver error and a 500; this turns it into a
   * `validation_failed` naming the offending field.
   *
   * `active` only, exactly as `ConversationCommandService` argues it: a removed
   * account cannot answer, a suspended one has had its access cut, and an
   * `invited` user has no session to open the ticket with. Handing a stuck
   * ticket to any of them would look like a fix and be a second deferral.
   *
   * Outside the transaction, and knowingly: a user suspended in the milliseconds
   * between this read and the write lands assigned, which the next routing pass
   * or a supervisor corrects. A lock spanning the two would be a heavier cure
   * than the disease.
   */
  private async assertAssigneesExist(input: TicketAssignInput): Promise<void> {
    if (typeof input.userId === 'string') {
      const user = await this.prisma.user.findUnique({
        where: { id: input.userId, status: UserStatus.active },
        select: { id: true },
      });

      if (user === null) {
        throw new UnknownTicketAssigneeError('userId', 'user', input.userId);
      }
    }

    if (typeof input.teamId === 'string') {
      const team = await this.prisma.team.findUnique({
        where: { id: input.teamId },
        select: { id: true },
      });

      if (team === null) {
        throw new UnknownTicketAssigneeError('teamId', 'team', input.teamId);
      }
    }
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
 * Who holds the ticket once the body has been applied — the current row for a
 * field the request left out, the body's value for one it carried.
 *
 * Resolved against the row rather than passed through, because every question
 * the rest of the assign path asks — is anybody on it, did anything move, is it
 * `manual` or `pending` — is about the *result*, and `{ userId: null }` alone
 * does not say whether the ticket still belongs to a team.
 */
function assignmentAfter(before: TicketRow, input: TicketAssignInput): TicketAssignment {
  return {
    assignedUserId: input.userId === undefined ? before.assignedUserId : input.userId,
    assignedTeamId: input.teamId === undefined ? before.assignedTeamId : input.teamId,
  };
}

/**
 * Whether the write would change anything at all — the assignment columns or the
 * three routing ones.
 *
 * A second identical submit writes nothing and answers 200 with the current
 * ticket, the rule `update` states at length: a double-clicked **Assign** button
 * and a retry after a dropped response both arrive as this, and each would
 * otherwise put another `assigned` row in the history an escalation is read
 * from. The routing columns are part of the comparison because assigning a
 * ticket to the team it already carries is a no-op on the assignment and still
 * has to move a `deferred` ticket to `manual`.
 */
function movesAnything(before: TicketRow, assignment: TicketAssignment): boolean {
  return (
    before.assignedUserId !== assignment.assignedUserId ||
    before.assignedTeamId !== assignment.assignedTeamId ||
    before.routingState !== routingStateFor(assignment) ||
    before.routingDeferredReason !== null ||
    before.routingDeferredSince !== null
  );
}

function hasAssignee(assignment: TicketAssignment): boolean {
  return assignment.assignedUserId !== null || assignment.assignedTeamId !== null;
}

/**
 * `manual` while somebody holds the ticket — routing must not overrule a
 * person's decision (0008 decision 3) — and `pending` once nobody does, per
 * amendment 2. Never `deferred` from this route: a supervisor releasing a ticket
 * on purpose is not rotation failing to place one.
 */
function routingStateFor(assignment: TicketAssignment): TicketRoutingState {
  return hasAssignee(assignment) ? 'manual' : 'pending';
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
