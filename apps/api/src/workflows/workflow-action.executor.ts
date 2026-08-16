import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  NotifyAction,
  ReassignAction,
  WorkflowAction,
  WorkflowActionResult,
} from '@whatsappcrm/contracts';
import { describeFailure } from '../common/describe-failure';
import { UserRole, UserStatus } from '../generated/prisma/enums';
import { resolveAlertRecipients, type AlertCandidate } from '../people/supervisor-recipients';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  TicketCommandService,
  type TicketAutomationResult,
} from '../tickets/ticket-command.service';

/**
 * One action, executed. 0009's `WorkflowActionExecutor`, and **the only
 * component in this module that writes outside it**.
 *
 * ## Sequential, independent, and a failure stops the rest
 *
 * Actions run in the declared order, each in its own transaction, and the run
 * records the outcome of each (0009, decision 5). Two reasons the list is not
 * wrapped in one transaction:
 *
 *   * `TicketCommandService` owns its own transactions and emits after commit,
 *     so an outer transaction would mean either rewriting it for workflows or
 *     emitting sockets for writes that later roll back.
 *   * A partial result is the honest one. If the ticket was tagged and the
 *     notification failed, "tagged, notification failed" is what happened, and a
 *     run row claiming nothing happened would be a lie a supervisor debugs
 *     against.
 *
 * **Stopping rather than continuing** is the conservative half, and the caller
 * is what enforces it: actions in a list are usually ordered because the later
 * ones assume the earlier ones ("reassign to the escalation team, then notify
 * that team"), and running the notify after the reassign failed tells somebody
 * about work they did not receive.
 *
 * ## Nothing here throws for a tenant's own mistake
 *
 * A refused transition, a ticket that vanished, a tag that was deleted between
 * the claim and the write — all of them come back as a `failed` result carrying
 * a typed reason. Only an infrastructure fault propagates, and the caller turns
 * that into `internal_error` on the run rather than a failed job: a tenant's
 * malformed workflow must not fill the failed set that is monitored for real
 * faults (0009, decision 2).
 */

/** What one action did, before the caller stamps its index onto it. */
export interface ActionOutcome {
  readonly outcome: WorkflowActionResult['outcome'];
  /** A `WorkflowFailureReason` on `failed`; null otherwise. */
  readonly reason: string | null;
  /**
   * The triggering occurrence this action raised, when it wrote one.
   *
   * Handed up rather than acted on, because the chained job has to carry
   * `depth + 1` and the causing run id — and only `WorkflowTriggerService` knows
   * either. This is the whole mechanism behind 0009's second loop bound.
   */
  readonly occurrence: TicketAutomationResult['occurrence'];
}

/** Which run is executing, so the ticket event and the notification can name it. */
export interface ActionContext {
  readonly tenantId: string;
  readonly ticketId: string;
  readonly workflowId: string;
  readonly workflowRunId: string;
}

/**
 * The roles a `supervisors` notify reaches — the same population as "holds
 * `ticket:read_all`" in 0004's matrix, so a notification exposes nothing its
 * recipient could not already read.
 */
const SUPERVISOR_ROLES: readonly UserRole[] = [UserRole.supervisor, UserRole.admin];

@Injectable()
export class WorkflowActionExecutor {
  private readonly logger = new Logger(WorkflowActionExecutor.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tickets: TicketCommandService,
  ) {}

  async execute(action: WorkflowAction, context: ActionContext): Promise<ActionOutcome> {
    try {
      switch (action.type) {
        case 'set_status':
          return fromTicketOutcome(
            await this.tickets.applyAutomation(
              context.ticketId,
              { kind: 'status', status: action.status },
              context,
            ),
          );
        case 'set_priority':
          return fromTicketOutcome(
            await this.tickets.applyAutomation(
              context.ticketId,
              { kind: 'priority', priority: action.priority },
              context,
            ),
          );
        case 'reassign':
          return await this.reassign(action, context);
        case 'add_ticket_tag':
          return await this.addTicketTag(action.tagId, context);
        case 'notify':
          return await this.notify(action, context);
      }
    } catch (error: unknown) {
      // Named, and the run carries it — but the log line is what carries the
      // stack. No PII: the workflow, the ticket and the failure, never a
      // `notify` body or a tag name.
      this.logger.error(
        `Workflow ${context.workflowId} action ${action.type} failed on ticket ` +
          `${context.ticketId}: ${describeFailure(error)}`,
      );

      return { outcome: 'failed', reason: 'internal_error', occurrence: null };
    }
  }

  /**
   * Reassignment goes through `TicketCommandService` like the other two ticket
   * writes, but the **target is re-read in tenant scope first**.
   *
   * `workflow_references` and its composite foreign keys stop a tag or a team
   * from being deleted while a workflow names it, and permit a *user* removal
   * because that is a security action which must always succeed. So the case
   * this read catches is real and is exactly the one 0009 decision 6's fourth
   * mechanism describes: a user removed between the claim and the action. It
   * comes back `reference_missing`, which deactivates the workflow rather than
   * letting it fail silently on every ticket for a week.
   *
   * Assigning to a team the tenant no longer has is the same answer by the same
   * route, even though the foreign key makes it near-unreachable — belt and
   * braces, because the alternative is a foreign-key violation surfacing as an
   * `internal_error` a supervisor cannot read.
   */
  private async reassign(action: ReassignAction, context: ActionContext): Promise<ActionOutcome> {
    if (action.target.kind === 'team') {
      const team = await this.prisma.team.findUnique({
        where: { id: action.target.teamId },
        select: { id: true },
      });

      if (team === null) {
        return { outcome: 'failed', reason: 'reference_missing', occurrence: null };
      }

      return fromTicketOutcome(
        await this.tickets.applyAutomation(
          context.ticketId,
          { kind: 'assignment', assignedUserId: null, assignedTeamId: team.id },
          context,
        ),
      );
    }

    // `active` only, exactly as `TicketCommandService.assign` argues it: a
    // removed account cannot answer, a suspended one has had its access cut, and
    // an `invited` user has no session to open the ticket with. Escalating to
    // any of them would look like a fix and be a second deferral.
    const user = await this.prisma.user.findUnique({
      where: { id: action.target.userId, status: UserStatus.active },
      select: { id: true },
    });

    if (user === null) {
      return { outcome: 'failed', reason: 'reference_missing', occurrence: null };
    }

    return fromTicketOutcome(
      await this.tickets.applyAutomation(
        context.ticketId,
        { kind: 'assignment', assignedUserId: user.id, assignedTeamId: null },
        context,
      ),
    );
  }

  /**
   * `ticket_tags`, the one write this module makes directly.
   *
   * `UNIQUE (tenant_id, ticket_id, tag_id)` is what lets a repeat report `no_op`
   * instead of failing a run — applying a tag twice is a no-op, not an error,
   * and the schema says so. `createMany` with `skipDuplicates` is that unique
   * expressed as `ON CONFLICT DO NOTHING`, and the count it returns is how the
   * outcome is decided without a read first.
   *
   * The tag is **not** re-read before the insert. The composite foreign key
   * `(tenant_id, tag_id)` is the check, and it is a stronger one: a tag deleted
   * between a read and this write would slip past a read and cannot slip past
   * the constraint. A violation lands in the `catch` below as
   * `reference_missing` rather than as an `internal_error`, which is the one
   * thing a bare constraint would get wrong.
   */
  private async addTicketTag(tagId: string, context: ActionContext): Promise<ActionOutcome> {
    try {
      const { count } = await this.prisma.ticketTag.createMany({
        data: [{ tenantId: context.tenantId, ticketId: context.ticketId, tagId }],
        skipDuplicates: true,
      });

      return count === 0
        ? { outcome: 'no_op', reason: null, occurrence: null }
        : { outcome: 'applied', reason: null, occurrence: null };
    } catch (error: unknown) {
      if (isForeignKeyViolation(error)) {
        return { outcome: 'failed', reason: 'reference_missing', occurrence: null };
      }

      throw error;
    }
  }

  /**
   * A `notifications` row per recipient, and the second idempotency layer with
   * it.
   *
   * `dedupe_key` is the run id, against `UNIQUE (tenant_id, recipient_user_id,
   * dedupe_key)`: the load-bearing guarantee is the run claim, and this covers
   * the window between that claim and these inserts — a retry after a partial
   * failure re-inserts nothing. It mirrors what the SLA path does with
   * `(tenant_id, sla_timer_id, recipient_user_id)`, generalised with the table
   * (0009, decision 7).
   *
   * **Nobody to tell is not a failure.** A tenant whose only supervisor was
   * suspended gets `no_op` and a warning naming the ticket — the same call
   * `SlaSweepService` makes, and for the same reason: the automation ran and
   * there was no audience, which is a fact a supervisor may need but is not
   * something the run should be marked failed for.
   */
  private async notify(action: NotifyAction, context: ActionContext): Promise<ActionOutcome> {
    const recipientUserIds = await this.resolveRecipients(action, context);

    if (recipientUserIds.length === 0) {
      this.logger.warn(
        `Workflow ${context.workflowId} notified nobody on ticket ${context.ticketId}: ` +
          `the ${action.audience} audience resolved to no active user.`,
      );

      return { outcome: 'no_op', reason: null, occurrence: null };
    }

    const { count } = await this.prisma.notification.createMany({
      data: recipientUserIds.map((recipientUserId) => ({
        tenantId: context.tenantId,
        // Explicit rather than left to the column default, on the rule
        // `SlaAlertService.insertForBreach` states: the default exists so that a
        // writer which forgets the column fails the CHECK loudly, and relying on
        // it here would make this the writer that forgot.
        type: 'workflow_notify' as const,
        ticketId: context.ticketId,
        recipientUserId,
        // The three `sla_breach` columns stay null, which
        // `notifications_sla_breach_columns` requires for every other type.
        data: {
          workflowId: context.workflowId,
          workflowRunId: context.workflowRunId,
          ...(action.message === null ? {} : { message: action.message }),
        },
        dedupeKey: context.workflowRunId,
      })),
      skipDuplicates: true,
    });

    return count === 0
      ? { outcome: 'no_op', reason: null, occurrence: null }
      : { outcome: 'applied', reason: null, occurrence: null };
  }

  /**
   * Who a `notify` reaches, per audience.
   *
   * `supervisors` goes through `resolveAlertRecipients` — the same pure rule
   * 0006 decision 4 published and the SLA path uses, which is why it now lives
   * in `people/` rather than in either L4 module (0009, delta 4). The candidate
   * *query* is repeated here rather than shared: it is six lines against
   * `users (tenant_id, status)`, and the alternative is `WorkflowsModule`
   * importing `SlaModule`, which the layering rule forbids and which would put
   * two features in one failure domain for the sake of one `findMany`.
   *
   * `user` and `team` resolve to active members only, for the reason the
   * reassign path gives: a suspended account cannot act on what it is told.
   */
  private async resolveRecipients(action: NotifyAction, context: ActionContext): Promise<string[]> {
    if (action.audience === 'user') {
      const user =
        action.userId === null
          ? null
          : await this.prisma.user.findUnique({
              where: { id: action.userId, status: UserStatus.active },
              select: { id: true },
            });

      return user === null ? [] : [user.id];
    }

    if (action.audience === 'team') {
      if (action.teamId === null) {
        return [];
      }

      const members = await this.prisma.teamMember.findMany({
        where: { teamId: action.teamId, user: { status: UserStatus.active } },
        select: { userId: true },
      });

      return members.map((member) => member.userId);
    }

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: context.ticketId },
      select: { assignedUserId: true, assignedTeamId: true },
    });

    if (ticket === null) {
      return [];
    }

    const candidates = await this.loadSupervisorCandidates();

    return resolveAlertRecipients(candidates, {
      assignedUserId: ticket.assignedUserId,
      assignedTeamId: ticket.assignedTeamId,
      assignedUserTeamIds: await this.teamsOf(ticket.assignedUserId),
    });
  }

  private async loadSupervisorCandidates(): Promise<AlertCandidate[]> {
    const candidates = await this.prisma.user.findMany({
      where: { role: { in: [...SUPERVISOR_ROLES] }, status: UserStatus.active },
      select: { id: true, teamMemberships: { select: { teamId: true } } },
    });

    return candidates.map((candidate) => ({
      id: candidate.id,
      teamIds: candidate.teamMemberships.map((membership) => membership.teamId),
    }));
  }

  private async teamsOf(userId: string | null): Promise<readonly string[]> {
    if (userId === null) {
      return [];
    }

    const memberships = await this.prisma.teamMember.findMany({
      where: { userId },
      select: { teamId: true },
    });

    return memberships.map((membership) => membership.teamId);
  }
}

/**
 * `TicketAutomationOutcome` → the run's vocabulary.
 *
 * The two refusals map to `failed` with their own typed reason rather than to
 * `skipped`: the action was attempted and did not happen, which is what a
 * supervisor filtering the run list on `transition_refused` is looking for.
 */
function fromTicketOutcome(result: TicketAutomationResult): ActionOutcome {
  switch (result.outcome) {
    case 'applied':
      // The only branch that carries an occurrence up: a write that happened is
      // the only kind of action that can start a chain.
      return { outcome: 'applied', reason: null, occurrence: result.occurrence };
    case 'no_op':
      return { outcome: 'no_op', reason: null, occurrence: null };
    case 'transition_refused':
      return { outcome: 'failed', reason: 'transition_refused', occurrence: null };
    case 'ticket_gone':
      return { outcome: 'failed', reason: 'ticket_gone', occurrence: null };
  }
}

/**
 * Prisma's code for a foreign-key violation. Matched on the code rather than the
 * message, which is a driver string that changes between minor versions.
 */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2003'
  );
}
