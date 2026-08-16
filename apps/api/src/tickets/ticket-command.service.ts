import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  SLA_EVALUATE_TICKET_JOB,
  SLA_QUEUE,
  TICKET_STATUS_REQUIRES_CLOSE,
  WORKFLOWS_QUEUE,
  WORKFLOW_EVALUATE_TICKET_JOB,
  canAgentTransition,
  ticketAssignRequiresReason,
  type SessionPrincipal,
  type SlaEvaluateTicketTrigger,
  type TicketAssignInput,
  type TicketEscalateInput,
  type TicketEscalationResponse,
  type TicketPriority,
  type TicketResponse,
  type TicketRoutingState,
  type TicketStatus,
  type TicketUpdateInput,
  type WorkflowEvaluateTicketTrigger,
  type WorkflowTriggerType,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  TICKET_ESCALATED_EVENT,
  TICKET_UPDATED_EVENT,
  type TicketEscalatedEvent,
  type TicketUpdatedEvent,
} from '../events/domain-events';
import type { Prisma } from '../generated/prisma/client';
import { UserStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { QueueService } from '../queue/queue.service';
import { EscalationAlertService, type InsertedEscalationAlert } from './escalation-alert.service';
import {
  ESCALATED_TO_USER_ID,
  TICKET_EVENT_PROJECTION,
  toTicketEventResponse,
  type TicketEventRow,
} from './ticket-event.mapper';
import { TICKET_PROJECTION, toTicketResponse, type TicketRow } from './ticket.mapper';
import { TicketQueryService } from './ticket-query.service';
import {
  TicketCloseNotPermittedError,
  TicketHandoffNotPermittedError,
  TicketNotFoundError,
  TicketReasonRequiredError,
  TicketStatusChangedConcurrentlyError,
  TicketTransitionNotAllowedError,
  UnknownTicketAssigneeError,
} from './tickets.errors';

/** Everything an agent-driven change writes, recorded as `agent` on the event log. */
const AGENT_CAUSE = 'agent';

/**
 * What a workflow-driven change writes instead (TAR-27).
 *
 * `TICKET_EVENT_TYPES` needs no new member: a workflow's status change is a
 * `status_changed` with a null actor and `{ workflowId, workflowRunId }` in
 * `data`, and its assignment is an `assigned`. A `workflow_ran` event type was
 * considered and rejected — `workflow_runs` is the automation log and it is
 * queryable, whereas a second copy in an append-only ticket log would be two
 * records of one fact with no way to reconcile them.
 */
const WORKFLOW_CAUSE = 'workflow';

/** No field moving. Spread with exactly one override by the automation path. */
const EMPTY_CHANGE: TicketChange = { status: null, priority: null, subject: null };

/** An automation result that raised no triggering occurrence — every non-`applied` one. */
const NO_OCCURRENCE = (outcome: TicketAutomationOutcome): TicketAutomationResult => ({
  outcome,
  occurrence: null,
});

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
 * What one workflow action asks this service to change (TAR-27, 0009 decision 5,
 * delta 1).
 *
 * A discriminated union rather than a partial `TicketUpdateInput`, because an
 * action list applies its members **one at a time, each in its own
 * transaction**: an action that succeeded stays done when a later one fails, and
 * the run records the outcome of each. A shape that could carry two changes at
 * once would invite a caller to collapse two actions into one write and lose
 * that per-action result.
 */
export type TicketAutomationChange =
  | { readonly kind: 'status'; readonly status: TicketStatus }
  | { readonly kind: 'priority'; readonly priority: TicketPriority }
  | {
      readonly kind: 'assignment';
      readonly assignedUserId: string | null;
      readonly assignedTeamId: string | null;
    };

/** Which workflow run is asking. Recorded on the ticket event, never on a log line. */
export interface TicketAutomationContext {
  readonly workflowId: string;
  readonly workflowRunId: string;
}

/**
 * What an automation write did.
 *
 * `no_op` is not `applied`: setting a status the ticket already holds changed
 * nothing, and the run should say so rather than claim a write. `ticket_gone`
 * and `transition_refused` are the two refusals that are **returned rather than
 * thrown** — a tenant's own rule attempting something the transition table
 * forbids is a fact about that rule, not a fault, and must not fill the failed
 * job set that is monitored for infrastructure problems.
 */
export type TicketAutomationOutcome = 'applied' | 'no_op' | 'transition_refused' | 'ticket_gone';

/**
 * The outcome, plus the `ticket_events` row the write appended when it applied
 * one.
 *
 * The event id is returned rather than acted on here because **this service must
 * not raise the chained trigger itself**: a workflow's own write is a triggering
 * occurrence like any other, but the job it produces has to carry `depth + 1`
 * and the id of the run that caused it, and neither of those is knowable from
 * inside a ticket write. `WorkflowTriggerService` owns the chain and its bound
 * (0009, loop protection); this hands it the occurrence and stays out of it.
 */
export interface TicketAutomationResult {
  readonly outcome: TicketAutomationOutcome;
  /** Null unless `outcome` is `applied` **and** the write raised a trigger type. */
  readonly occurrence: {
    readonly triggerType: WorkflowTriggerType;
    readonly ticketEventId: string;
  } | null;
}

/**
 * The three writes into a ticket: the agent's `PATCH /api/v1/tickets/{id}`
 * (TAR-25, ruled by 0006), `POST /api/v1/tickets/{id}/assign` (TAR-23, ruled by
 * 0008 decision 3 and widened to a handoff by 0011 decision 2), and
 * `POST /api/v1/tickets/{id}/escalate` (TAR-32, ruled by 0011 decision 3).
 *
 * The event log *read* is `TicketEventQueryService`, beside this file.
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
    private readonly escalations: EscalationAlertService,
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

    const { after, statusEventId } = await this.write(before, change);

    this.announceUpdate(before, after);
    await this.triggerSlaEvaluation(before, after);
    await this.triggerWorkflowEvaluation(after.id, 'ticket_status_changed', statusEventId);

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
   *
   * ## TAR-32 adds two rules in front of the write, in a fixed order
   *
   * `require` (visibility) → the handoff bound → the reason rule → assignee
   * existence → the no-op check → the write. The order is the reviewable part
   * and each step earns its place:
   *
   *   * **the handoff bound before everything else**, because a caller who may
   *     not make this write at all should not learn from the response whether a
   *     user id they named exists in the tenant;
   *   * **the reason rule before `assertAssigneesExist`**, so a caller missing a
   *     reason is told that rather than being sent to check a user id that was
   *     fine;
   *   * **both before the no-op check**, deliberately. A request that moves
   *     nothing still answers 200 with the current ticket, but a missing reason
   *     on such a request is still refused — silently accepting it would train a
   *     console to omit the field.
   */
  async assign(ticketId: string, input: TicketAssignInput): Promise<TicketResponse> {
    const before = await this.tickets.require(ticketId);
    const assignment = assignmentAfter(before, input);

    await this.assertHandoffAllowed(before, input, assignment);
    assertReasonGiven(before, input);
    await this.assertAssigneesExist(input);

    if (!movesAnything(before, assignment)) {
      return toTicketResponse(before);
    }

    const { after, eventId } = await this.writeAssignment(before, assignment, input.reason);

    await this.triggerWorkflowEvaluation(after.id, 'ticket_assigned', eventId);

    return toTicketResponse(after);
  }

  /**
   * 0009 delta 2: a triggering occurrence, enqueued **after the transaction that
   * caused it commits**.
   *
   * The same shape TAR-24 and TAR-26 already added — an enqueue, never a call.
   * `WorkflowsModule` is L4 and this is L3, so what crosses the line is the
   * payload in `@whatsappcrm/contracts/workflows` and a queue name.
   *
   * `occurrenceId` is the `ticket_events` row this occurrence **is**, which is
   * what makes the dedupe key say "once per recorded change" rather than "once
   * per ticket". The id already exists, is already unique, and is already the
   * audit record of the thing that fired — so a run can be joined back to its
   * cause with no new identifier.
   *
   * `depth: 0` and `causedByRunId: null` because a person did this. A trigger
   * raised by a workflow *action* carries its cause's depth plus one, and that
   * path goes through `applyAutomation` below.
   *
   * Failure to enqueue is logged rather than thrown, per `QueueService`'s
   * contract: the ticket change is committed and the caller is owed their 200.
   * **This is a real gap, not a shrug** — 0009 risk 3 records it: event triggers
   * have no reconciler, so a `ticket_status_changed` workflow can miss a ticket
   * during a Redis outage and never learn. Elapsed triggers self-heal because
   * the sweep re-derives from `tickets.created_at`; these do not.
   */
  private async triggerWorkflowEvaluation(
    ticketId: string,
    triggerType: WorkflowTriggerType,
    occurrenceId: string | null,
  ): Promise<void> {
    if (occurrenceId === null) {
      return;
    }

    const trigger: WorkflowEvaluateTicketTrigger = {
      tenantId: this.tenantContext.requireTenantId(),
      ticketId,
      triggerType,
      occurrenceId,
      depth: 0,
      causedByRunId: null,
    };

    const outcome = await this.queue.enqueue<WorkflowEvaluateTicketTrigger>(
      WORKFLOWS_QUEUE,
      WORKFLOW_EVALUATE_TICKET_JOB,
      trigger,
      {
        // No custom `jobId` — see the note in `@whatsappcrm/contracts/workflows`.
        // A ticket-keyed id would collapse this occurrence into the completed
        // key of the previous one.
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Ticket ${ticketId} raised ${triggerType} but its workflow evaluation was not queued ` +
          `(${outcome}); no automation will run for this occurrence.`,
      );
    }
  }

  /**
   * `POST /api/v1/tickets/{id}/escalate` — an agent asking for supervisor
   * attention (TAR-32, ADR 0011 decision 3).
   *
   * ## The ticket does not change hands
   *
   * Nothing in this method touches the assignment or routing columns, and that
   * is the decision rather than an omission: an escalation that un-assigned the
   * agent would leave the customer with nobody at 02:14 while the supervisor
   * sleeps, and would make "escalate" the one button that loses your work. A
   * supervisor who wants to take the ticket uses `assign`, which is the route
   * for changing hands.
   *
   * So the response is **not** a `TicketResponse`: nothing on the ticket moved,
   * and returning one would hide the only fact the caller needs — the audit
   * entry, and who was told.
   *
   * ## The order, which is the reviewable part (0011 decision 5)
   *
   *   1. `require` — visibility. A ticket the caller may not see is `not_found`,
   *      here as everywhere else in this service. That is the *only* bound on
   *      this route: `ticket:escalate` is held by every role, deliberately, so a
   *      colleague spotting a problem on a team ticket can raise it.
   *   2. Resolve recipients, **outside** the transaction — see
   *      `EscalationAlertService.resolveRecipients` for the trade.
   *   3. One transaction: the `escalated` event, then the alerts referencing it.
   *      Both or neither.
   *   4. After commit: one socket per row actually inserted.
   *
   * ## Re-escalation is allowed
   *
   * A second ask an hour after the first is a legitimate act, and swallowing it
   * would make the button lie in exactly the situation it exists for. The
   * console disables the control while a request is in flight, and the route
   * honours an optional `Idempotency-Key` — applied by the controller, so a
   * retry after a dropped response replays the first result instead of notifying
   * everybody twice.
   *
   * ## Nobody to tell is a real outcome, not an error
   *
   * A tenant with no active supervisor or admin gets the event written and an
   * empty `notifiedUserIds`. The agent did nothing wrong and has no way to fix
   * it, so it is logged for the operator — the count of escalations reaching
   * nobody is a misconfigured-tenant signal — and reported honestly to the
   * console, which says "recorded, but nobody was notified".
   */
  async escalate(ticketId: string, input: TicketEscalateInput): Promise<TicketEscalationResponse> {
    const ticket = await this.tickets.require(ticketId);
    const recipientUserIds = await this.escalations.resolveRecipients(ticket, input.toUserId);
    const { event, alerts } = await this.writeEscalation(ticket, input, recipientUserIds);

    if (alerts.length === 0) {
      this.logger.warn(
        `Ticket ${ticket.id} was escalated and no alert was written: this tenant has no active ` +
          'supervisor or admin to notify. The escalation is on the ticket history.',
      );
    } else {
      this.announceEscalation(ticket.id, alerts);
    }

    return {
      event: toTicketEventResponse(event),
      notifiedUserIds: alerts.map((alert) => alert.recipientUserId),
    };
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
  private async write(
    before: TicketRow,
    change: TicketChange,
  ): Promise<{ after: TicketRow; statusEventId: string | null }> {
    const tenantId = this.tenantContext.requireTenantId();
    const actorUserId = this.tenantContext.requirePrincipal().userId;

    return this.prisma.$tenantTransaction(async (tx) => {
      const { count } = await tx.ticket.updateMany({
        where: { tenantId, id: before.id, status: before.status },
        data: toUpdateData(change, actorUserId),
      });

      if (count === 0) {
        throw new TicketStatusChangedConcurrentlyError(before.id, before.status);
      }

      let statusEventId: string | null = null;

      if (change.status !== null) {
        // The id is selected because it *is* the triggering occurrence a
        // workflow dedupes on (0009, decision 2). Nothing else reads it.
        const event = await tx.ticketEvent.create({
          data: {
            tenantId,
            ticketId: before.id,
            type: 'status_changed',
            actorUserId,
            data: { from: before.status, to: change.status, cause: AGENT_CAUSE },
          },
          select: { id: true },
        });

        statusEventId = event.id;
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
      const after = await tx.ticket.findUniqueOrThrow({
        where: { id: before.id },
        select: TICKET_PROJECTION,
      });

      return { after, statusEventId };
    });
  }

  /**
   * The system-actor entry point onto **this same write path** (0009 decision 5,
   * delta 1) — the one thing `WorkflowsModule` requires of `TicketsModule`.
   *
   * ## Why this exists rather than a second implementation inside the executor
   *
   * A ticket status write carries five behaviours that live here today:
   * `TICKET_STATUS_TRANSITIONS`, `resolved_at`/`closed_at` stamping, the
   * `status_changed` ticket event, the `sla.evaluate-ticket` enqueue that pauses
   * or stops a timer, and the realtime announcement. A second implementation
   * inside `WorkflowActionExecutor` would drift, and the first symptom would be a
   * workflow closing a ticket whose SLA timer never stopped.
   *
   * ## Three differences from the principal path, and only three
   *
   *   * **No principal.** The ticket is read straight off `TenantPrisma` rather
   *     than through `TicketQueryService.require`, which applies the
   *     assigned-to-me visibility rule against a caller that does not exist here.
   *     Tenant isolation is unaffected — RLS is what holds it, and the worker set
   *     its scope from `job.data.tenantId` before its first statement.
   *   * **`ticket_events.actor_user_id` is null**, which the column is already
   *     documented as meaning "the system", and `data` carries
   *     `{ workflowId, workflowRunId }` so a supervisor reading the history can
   *     find the rule that did it.
   *   * **No permission check.** A workflow has no principal to check; the
   *     permission that mattered was `workflow:write`, checked when a supervisor
   *     armed it. This is why 0009 puts any future customer-facing action behind
   *     a *write-time* permission rather than an execution-time one.
   *
   * **`TICKET_STATUS_TRANSITIONS` still applies**, and that is deliberate: a
   * workflow may not reopen a `closed` ticket, because
   * `tickets_one_active_per_contact` is a partial unique index and re-activating
   * a resolved ticket for a contact who now holds another one raises a
   * constraint violation. A workflow attempting it gets `transition_refused`
   * back and **nothing is thrown** — the run records it and the job succeeds.
   */
  async applyAutomation(
    ticketId: string,
    change: TicketAutomationChange,
    context: TicketAutomationContext,
  ): Promise<TicketAutomationResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const before = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: TICKET_PROJECTION,
    });

    if (before === null) {
      return NO_OCCURRENCE('ticket_gone');
    }

    if (change.kind === 'assignment') {
      return await this.applyAutomationAssignment(tenantId, before, change, context);
    }

    if (change.kind === 'priority') {
      // A re-prioritisation raises no trigger: `WORKFLOW_TRIGGER_TYPES` has no
      // priority member, so this write is a ticket change with no automation
      // consequence and cannot start a chain.
      return change.priority === before.priority
        ? NO_OCCURRENCE('no_op')
        : await this.applyAutomationField(
            tenantId,
            before,
            { ...EMPTY_CHANGE, priority: change.priority },
            context,
            null,
          );
    }

    if (change.status === before.status) {
      return NO_OCCURRENCE('no_op');
    }

    if (!canAgentTransition(before.status, change.status)) {
      return NO_OCCURRENCE('transition_refused');
    }

    return await this.applyAutomationField(
      tenantId,
      before,
      { ...EMPTY_CHANGE, status: change.status },
      context,
      'ticket_status_changed',
    );
  }

  /**
   * The status or priority half, in one transaction, then the same after-commit
   * fan-out the agent path performs.
   *
   * The compare-and-set on `status` is kept exactly as the agent path states it:
   * `TicketLinkerService` writes the same column off the inbound-message queue,
   * and a workflow is a third writer that must lose the same race the same way.
   * A lost compare-and-set here is `no_op`, not a retry — re-applying "resolve"
   * from a status that just moved would resolve a ticket the customer has just
   * replied on, which is precisely what the guard exists to prevent.
   */
  private async applyAutomationField(
    tenantId: string,
    before: TicketRow,
    change: TicketChange,
    context: TicketAutomationContext,
    raises: WorkflowTriggerType | null,
  ): Promise<TicketAutomationResult> {
    const written = await this.prisma.$tenantTransaction(async (tx) => {
      const { count } = await tx.ticket.updateMany({
        where: { tenantId, id: before.id, status: before.status },
        // Null actor: a workflow resolved this, not a person, so
        // `resolved_by_user_id` stays null rather than crediting somebody.
        data: toUpdateData(change, null),
      });

      if (count === 0) {
        return null;
      }

      const event = await tx.ticketEvent.create({
        data: {
          tenantId,
          ticketId: before.id,
          type: change.status !== null ? 'status_changed' : 'priority_changed',
          // Null actor: a workflow did this, not a person. The column is already
          // documented as null for the system.
          actorUserId: null,
          data:
            change.status !== null
              ? { from: before.status, to: change.status, cause: WORKFLOW_CAUSE, ...context }
              : { from: before.priority, to: change.priority, cause: WORKFLOW_CAUSE, ...context },
        },
        select: { id: true },
      });

      const after = await tx.ticket.findUniqueOrThrow({
        where: { id: before.id },
        select: TICKET_PROJECTION,
      });

      return { after, eventId: event.id };
    });

    if (written === null) {
      return NO_OCCURRENCE('no_op');
    }

    this.announceAutomation(before, written.after);
    await this.triggerSlaEvaluation(before, written.after);

    return {
      outcome: 'applied',
      occurrence: raises === null ? null : { triggerType: raises, ticketEventId: written.eventId },
    };
  }

  /** The assignment half. Last writer wins, exactly as the supervisor's route does. */
  private async applyAutomationAssignment(
    tenantId: string,
    before: TicketRow,
    change: Extract<TicketAutomationChange, { kind: 'assignment' }>,
    context: TicketAutomationContext,
  ): Promise<TicketAutomationResult> {
    const assignment: TicketAssignment = {
      assignedUserId: change.assignedUserId,
      assignedTeamId: change.assignedTeamId,
    };

    if (!movesAnything(before, assignment)) {
      return NO_OCCURRENCE('no_op');
    }

    const eventId = await this.prisma.$tenantTransaction(async (tx) => {
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
        return null;
      }

      const event = await tx.ticketEvent.create({
        data: {
          tenantId,
          ticketId: before.id,
          type: hasAssignee(assignment) ? 'assigned' : 'unassigned',
          actorUserId: null,
          data: {
            ...assignment,
            previousAssignedUserId: before.assignedUserId,
            previousAssignedTeamId: before.assignedTeamId,
            cause: WORKFLOW_CAUSE,
            ...context,
          } satisfies Prisma.InputJsonObject,
        },
        select: { id: true },
      });

      return event.id;
    });

    // Zero rows matched means the ticket was deleted underneath the action —
    // `not_found` on the agent's route, and here the run's own `ticket_gone`.
    if (eventId === null) {
      return NO_OCCURRENCE('ticket_gone');
    }

    return {
      outcome: 'applied',
      occurrence: { triggerType: 'ticket_assigned', ticketEventId: eventId },
    };
  }

  /**
   * The same `ticket.updated` the agent path emits, with a null actor.
   *
   * Separate from `announceUpdate` for one reason: that method reads
   * `requirePrincipal()`, and a worker has none. The event's `actorUserId` is
   * already nullable and already documented as "null when the writer was the
   * system", so the payload shape does not change.
   */
  private announceAutomation(before: TicketRow, after: TicketRow): void {
    const event: TicketUpdatedEvent = {
      tenantId: this.tenantContext.requireTenantId(),
      ticketId: after.id,
      previousStatus: before.status,
      status: after.status,
      previousPriority: before.priority,
      priority: after.priority,
      actorUserId: null,
    };

    this.events.emit(TICKET_UPDATED_EVENT, event);
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
  ): Promise<{ after: TicketRow; eventId: string }> {
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

      const event = await tx.ticketEvent.create({
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
        select: { id: true },
      });

      const after = await tx.ticket.findUniqueOrThrow({
        where: { id: before.id },
        select: TICKET_PROJECTION,
      });

      return { after, eventId: event.id };
    });
  }

  /**
   * The `escalated` event and its alerts, in one transaction (0011 decision 5,
   * step 3).
   *
   * Both or neither, and the ordering is what makes it so: an alert without an
   * audit entry is a notification nobody can explain, and an audit entry without
   * alerts claims a supervisor was told when none was. The composite foreign key
   * `(tenant_id, ticket_event_id)` makes the first half structural — the alert
   * rows cannot reference an escalation the transaction did not commit.
   *
   * `tenantId` is supplied explicitly, as everywhere else in this service that
   * writes: `$tenantTransaction` hands back the **un-extended** client, so the
   * per-statement policy is not in play. RLS still applies — the GUC is set for
   * the whole transaction — and `ticket_events.tenant_id` is `NOT NULL`
   * regardless.
   *
   * The row is read back through `TICKET_EVENT_PROJECTION` rather than assembled
   * from the input, so the response carries the committed event — its id and its
   * database-clock `created_at` — and is byte-identical to the same event read
   * a moment later through `GET /tickets/{id}/events`.
   */
  private async writeEscalation(
    ticket: TicketRow,
    input: TicketEscalateInput,
    recipientUserIds: readonly string[],
  ): Promise<{ event: TicketEventRow; alerts: InsertedEscalationAlert[] }> {
    const tenantId = this.tenantContext.requireTenantId();
    // Never the system's null: this route is unreachable without a principal,
    // and an event claiming a system actor on a human decision would be a lie
    // the trail cannot recover from.
    const actorUserId = this.tenantContext.requirePrincipal().userId;

    return this.prisma.$tenantTransaction(async (tx) => {
      const event = await tx.ticketEvent.create({
        data: {
          tenantId,
          ticketId: ticket.id,
          type: 'escalated',
          actorUserId,
          data: {
            reason: input.reason,
            cause: AGENT_CAUSE,
            // Absent rather than null when the escalation was addressed to
            // whoever supervises this ticket. The published `toValue` is null
            // either way; the key is written only when there is a person to name.
            ...(input.toUserId === undefined ? {} : { [ESCALATED_TO_USER_ID]: input.toUserId }),
          } satisfies Prisma.InputJsonObject,
        },
        select: TICKET_EVENT_PROJECTION,
      });

      const alerts = await this.escalations.insertForEscalation(tx, {
        tenantId,
        ticketId: ticket.id,
        ticketEventId: event.id,
        recipientUserIds,
      });

      return { event, alerts };
    });
  }

  /**
   * The handoff bound: what a caller holding `ticket:handoff` but **not**
   * `ticket:assign` may do (ADR 0011 decision 2).
   *
   * The route declares the weaker permission so that every role can hand on
   * their own work, and this is the bound that keeps it from becoming the wider
   * right. A caller who does not hold `ticket:assign` may write only when all
   * three hold:
   *
   *   1. **they hold the ticket** — `assignedUserId === principal.userId`, not
   *      "their team holds it". A ticket routed to a team is nobody's to give
   *      away, and every member could otherwise reassign it out from under
   *      whoever is working it;
   *   2. **the target is a teammate** — a user sharing at least one team with
   *      the caller, or one of the caller's own teams. Read off the *body*, per
   *      the ADR: a ticket's existing team assignment is not re-checked, because
   *      handing your team-routed ticket to a teammate would otherwise be
   *      refused for a column the caller never touched, and leaving it on the
   *      team it already carries exposes it to nobody new;
   *   3. **they are not releasing it** — the result must leave somebody holding
   *      the ticket. Dropping it back to unassigned is abandonment, not a
   *      handoff, and puts the ticket in a state only `ticket:assign` can
   *      create.
   *
   * A caller holding `ticket:assign` skips all three; their write is unchanged
   * from what TAR-374 shipped.
   *
   * ⚠️ **A route whose declared permission is weaker than one of its behaviours
   * is where authorization bugs live.** This is the review item 0011 decision 2
   * names, and `ticket-handoff.int-spec.ts` asserts each of the three refusals
   * against a real database rather than leaving them to be read here.
   *
   * One indexed read at most, and only on the branch that needs it: the target's
   * shared teams, served by `team_members (tenant_id, user_id, team_id)` and
   * skipped entirely for a caller holding `ticket:assign`, a teamless caller, or
   * a body naming no user.
   */
  private async assertHandoffAllowed(
    before: TicketRow,
    input: TicketAssignInput,
    after: TicketAssignment,
  ): Promise<void> {
    const principal = this.tenantContext.requirePrincipal();

    if (principal.permissions.includes('ticket:assign')) {
      return;
    }

    if (before.assignedUserId !== principal.userId) {
      throw TicketHandoffNotPermittedError.notHeld();
    }

    if (typeof input.teamId === 'string' && !principal.teamIds.includes(input.teamId)) {
      throw TicketHandoffNotPermittedError.notATeammate();
    }

    if (typeof input.userId === 'string' && !(await this.isTeammate(principal, input.userId))) {
      throw TicketHandoffNotPermittedError.notATeammate();
    }

    if (!hasAssignee(after)) {
      throw TicketHandoffNotPermittedError.releasing();
    }
  }

  /**
   * Whether the target shares a team with the caller — "teammate" in TAR-32's
   * own word.
   *
   * Handing a ticket back to yourself is trivially allowed and costs no query:
   * you already hold it, so the write is the no-op `assign` answers 200 for.
   *
   * A teamless caller has no teammates and is refused without a query. Otherwise
   * one `findFirst` over the caller's own team ids — a existence check rather
   * than a list, because the answer is a boolean. `TenantPrisma` supplies the
   * tenant equality, so a target in another tenant is simply not there.
   */
  private async isTeammate(principal: SessionPrincipal, targetUserId: string): Promise<boolean> {
    if (targetUserId === principal.userId) {
      return true;
    }

    if (principal.teamIds.length === 0) {
      return false;
    }

    const shared = await this.prisma.teamMember.findFirst({
      where: { userId: targetUserId, teamId: { in: [...principal.teamIds] } },
      select: { teamId: true },
    });

    return shared !== null;
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

  /**
   * Tells the in-process bus that an escalation is committed, **after** the
   * transaction has landed — the rule every producer of these events follows,
   * and the reason a rollback can never push a notification nobody can explain.
   *
   * It carries the ids of the rows that were **actually inserted**, never the
   * recipients that were resolved. That is what bounds the relay to one socket
   * per row, which is what keeps the socket audience equal to the read rule.
   *
   * Unlike `ticket.updated` this one has a subscriber from day one: escalation
   * is addressed to `user:{recipientUserId}`, a room the realtime contract
   * already publishes to for `sla.breached`, so there is no rooms amendment
   * here — which is precisely what TAR-25 said it was waiting for.
   */
  private announceEscalation(ticketId: string, alerts: readonly InsertedEscalationAlert[]): void {
    const event: TicketEscalatedEvent = {
      tenantId: this.tenantContext.requireTenantId(),
      ticketId,
      alertIds: alerts.map((alert) => alert.id),
    };

    this.events.emit(TICKET_ESCALATED_EVENT, event);
  }
}

/**
 * The conditional half of the reason rule, which Zod cannot see (ADR 0011
 * decision 1).
 *
 * The schema owns the shape — trimmed, three characters, five hundred at most,
 * so the empty string cannot satisfy "present" and log nothing. This owns the
 * part that is about the **row**: a reason is required exactly when the ticket
 * already has a holder, because that is what makes the write a *reassignment*
 * rather than a placement.
 *
 * `ticketAssignRequiresReason` is the published predicate, imported rather than
 * re-expressed: the console asks it before it submits, and a second copy that
 * drifts is a form that refuses a submit the API would have accepted — or,
 * worse, offers one it will not.
 */
function assertReasonGiven(before: TicketRow, input: TicketAssignInput): void {
  if (input.reason === undefined && ticketAssignRequiresReason(before)) {
    throw new TicketReasonRequiredError();
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
 *
 * ## `resolvedByUserId` moves with `resolvedAt`, in the same statement
 *
 * TAR-30's per-agent breakdown needs to know who resolved a ticket, and ADR 0010
 * decision 4 records it here rather than deriving it later: this service already
 * knows `actorUserId` — it puts it on the `status_changed` event — and this is
 * the transaction that establishes the fact.
 *
 * Attributing to `assigned_user_id` at query time instead would rewrite history:
 * a ticket reassigned in March would move its January resolution onto a
 * different agent's row, changing a closed period's numbers after they were
 * reported to a client. The two columns are written together for the same reason
 * they are read together, and the no-overwrite property above covers both.
 *
 * Only on the transition into `resolved`. Closing an unresolved ticket writes
 * `closedAt` and neither of these — closing spam is not a resolution, and
 * `closed_at IS NOT NULL AND resolved_at IS NULL` is the "closed unworked"
 * signal the dashboard carries as its own count.
 *
 * **`actorUserId` is null when a workflow did it** (TAR-27). A `set_status`
 * action runs with no principal, so there is nobody to attribute the resolution
 * to — and `resolved_by_user_id` is nullable precisely so that "resolved, by no
 * agent" is representable. Writing the tenant's first admin, or the assignee,
 * would put a resolution on a person's per-agent row that they did not do, which
 * is the same history-rewriting this docblock refuses one paragraph up. A
 * dashboard counting resolutions per agent should not count automation as
 * anybody's work, and `resolved_at IS NOT NULL AND resolved_by_user_id IS NULL`
 * is the signal for the tenant that wants to see how much of it there is.
 */
function toUpdateData(
  change: TicketChange,
  actorUserId: string | null,
): Prisma.TicketUncheckedUpdateInput {
  const now = new Date();

  return {
    ...(change.status === null ? {} : { status: change.status }),
    ...(change.priority === null ? {} : { priority: change.priority }),
    ...(change.subject === null ? {} : { subject: change.subject }),
    ...(change.status === 'resolved' ? { resolvedAt: now, resolvedByUserId: actorUserId } : {}),
    ...(change.status === 'closed' ? { closedAt: now } : {}),
  };
}
