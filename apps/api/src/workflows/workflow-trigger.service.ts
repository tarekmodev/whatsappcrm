import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  WORKFLOWS_QUEUE,
  WORKFLOW_EVALUATE_TICKET_JOB,
  WORKFLOW_LIMITS,
  triggerIsTicketScoped,
  workflowDedupeKey,
  type WorkflowActionResult,
  type WorkflowDefinition,
  type WorkflowEvaluateTicketTrigger,
  type WorkflowFailureReason,
} from '@whatsappcrm/contracts';
import { randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { describeFailure } from '../common/describe-failure';
import { Prisma } from '../generated/prisma/client';
import { UserRole, UserStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { QueueService } from '../queue/queue.service';
import { WorkflowActionExecutor, type ActionOutcome } from './workflow-action.executor';
import { workflowMatches } from './workflow-conditions';
import { factsNeededBy, mergeFactsNeeded, type WorkflowFacts } from './workflow-facts';
import { WorkflowFactSheetService } from './workflow-fact-sheet.service';
import { readDefinition } from './workflow.mapper';
import { WORKFLOW_RUN_BUDGET_WINDOW_MS } from './workflows.constants';
import {
  MalformedWorkflowDefinitionError,
  WorkflowTicketNotVisibleError,
} from './workflows.errors';

/**
 * One triggering occurrence, turned into runs. 0009's `WorkflowTriggerService`,
 * and the heart of the feature.
 *
 * ## The claim is the whole exactly-once mechanism
 *
 * For each candidate workflow this computes a **dedupe key** from the workflow
 * and the occurrence, then claims a `workflow_runs` row with
 * `INSERT … ON CONFLICT (tenant_id, workflow_id, dedupe_key) DO NOTHING
 * RETURNING id`, and proceeds only if the insert returned. The row that records
 * what happened is the same row that reserves the right to make it happen — one
 * statement, one round trip, correct across replicas by construction.
 *
 * No row returned means another replica, another sweep tick, or an earlier
 * delivery of this job already owns this occurrence. The handler moves to the
 * next workflow and logs nothing: **a duplicate delivery is the normal case, not
 * an incident.**
 *
 * Nothing here reads `workflow_runs`, decides in TypeScript, and then inserts.
 * The window between such a read and its write is exactly the window two sweep
 * ticks race in, and the bug it produces — a duplicate escalation every minute —
 * is the one a supervisor experiences as a pager.
 *
 * ## Failure is recorded, not retried, once a run is claimed
 *
 * A claimed run that throws is written `failed` with a typed reason and **the
 * job succeeds**. Retrying would re-enter a claim that now conflicts, so the
 * retry could only ever no-op; and a tenant's malformed workflow must not fill
 * the failed set that is monitored for infrastructure faults. The two things
 * that still throw are the ones that are not about the workflow at all: a
 * database error before the claim, and a ticket that is not visible yet — most
 * often a job that overtook the transaction that created it.
 *
 * ## The elapsed threshold is checked *before* the claim, and that is load-bearing
 *
 * `ticket_unresolved_for` dedupes on `ticket:{id}` — once per ticket, ever. If a
 * 24-hour workflow claimed that key at hour four (because the sweep enqueued the
 * ticket for a 4-hour workflow in the same tenant) it would record `skipped` and
 * could **never fire again**, because the key is spent. So a workflow whose own
 * threshold is not yet met is passed over without claiming anything.
 */

/** What one evaluation did, for the runner's log line and for the tests. */
export interface WorkflowEvaluationReport {
  /** Active workflows whose trigger type matched. */
  readonly candidates: number;
  /** Runs this evaluation claimed. The rest were already owned. */
  readonly claimed: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly failed: number;
  /** True when the job was dropped for exceeding `maxChainDepth`. */
  readonly chainDepthExceeded: boolean;
}

const EMPTY_REPORT: WorkflowEvaluationReport = {
  candidates: 0,
  claimed: 0,
  succeeded: 0,
  skipped: 0,
  failed: 0,
  chainDepthExceeded: false,
};

/** One active workflow, compiled once per evaluation. */
interface CandidateWorkflow {
  readonly id: string;
  readonly version: number;
  readonly definition: WorkflowDefinition;
}

@Injectable()
export class WorkflowTriggerService {
  private readonly logger = new Logger(WorkflowTriggerService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly facts: WorkflowFactSheetService,
    private readonly executor: WorkflowActionExecutor,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  async evaluate(trigger: WorkflowEvaluateTicketTrigger): Promise<WorkflowEvaluationReport> {
    // Bound 2 of 0009's loop protection, and the first thing checked because it
    // is the one that costs nothing. Logged once with the causing run id so a
    // tenant with a rule cycle is findable; it does not page.
    if (trigger.depth > WORKFLOW_LIMITS.maxChainDepth) {
      this.logger.warn(
        `Dropped ${WORKFLOW_EVALUATE_TICKET_JOB} for ticket ${trigger.ticketId}: chain depth ` +
          `${trigger.depth} exceeds ${WORKFLOW_LIMITS.maxChainDepth} (caused by run ` +
          `${trigger.causedByRunId ?? 'unknown'}).`,
      );

      return { ...EMPTY_REPORT, chainDepthExceeded: true };
    }

    const candidates = await this.loadCandidates(trigger);

    if (candidates.length === 0) {
      return EMPTY_REPORT;
    }

    return await this.runCandidates(trigger, candidates);
  }

  /**
   * The hottest query in the module: the tenant's **active** workflows whose
   * trigger type matches, in execution order.
   *
   * Served by `workflows (tenant_id, is_active, trigger_type, position, id)`,
   * which is why `trigger_type` is a column duplicating a `definition` field
   * rather than a JSONB extraction — an extraction in the predicate cannot use a
   * composite index that also carries `position`.
   *
   * A definition that does not parse **skips that workflow and does not fail the
   * job**. This is the opposite of what the read path does, deliberately and for
   * the reason `assignment.errors.ts` gives about its own engine: here the job is
   * to not write to a live ticket on a definition it cannot read, while the API's
   * job is to tell the supervisor their configuration is corrupt.
   */
  private async loadCandidates(
    trigger: WorkflowEvaluateTicketTrigger,
  ): Promise<CandidateWorkflow[]> {
    const rows = await this.prisma.workflow.findMany({
      where: { isActive: true, triggerType: trigger.triggerType },
      select: { id: true, version: true, definition: true, triggerType: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      take: WORKFLOW_LIMITS.workflowsPerTenant,
    });

    return rows.flatMap((row) => {
      try {
        return [{ id: row.id, version: row.version, definition: readDefinition(row) }];
      } catch (error: unknown) {
        if (error instanceof MalformedWorkflowDefinitionError) {
          this.logger.error(
            `Skipping workflow ${row.id}: its definition does not parse. ${error.message}`,
          );

          return [];
        }

        throw error;
      }
    });
  }

  private async runCandidates(
    trigger: WorkflowEvaluateTicketTrigger,
    candidates: readonly CandidateWorkflow[],
  ): Promise<WorkflowEvaluationReport> {
    const dedupeKey = workflowDedupeKey(trigger);
    // The union of what every candidate reads, so the fact sheet is one lazy
    // load per job rather than one per workflow.
    const needed = mergeFactsNeeded(
      candidates.map((candidate) => factsNeededBy(candidate.definition.conditions)),
    );

    let facts: WorkflowFacts | null = null;
    const factSheet = async (): Promise<WorkflowFacts> => {
      facts ??= await this.facts.load(trigger.ticketId, needed);

      return facts;
    };

    let overBudget: boolean | null = null;
    const budgetExceeded = async (): Promise<boolean> => {
      overBudget ??= await this.isOverRunBudget(trigger.ticketId);

      return overBudget;
    };

    let claimed = 0;
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    // A ticket-scoped key — `ticket:{id}` — is spendable exactly once, ever, so
    // anything that consumes it without doing the work is permanent.
    const keyIsSpendableOnce = triggerIsTicketScoped(trigger.triggerType);

    for (const candidate of candidates) {
      // Before the claim, and only for the elapsed trigger — see the class
      // docblock for why the order matters more than it looks.
      if (candidate.definition.trigger.type === 'ticket_unresolved_for') {
        const { ageMinutes } = await factSheet();

        if (ageMinutes < candidate.definition.trigger.minutes) {
          continue;
        }
      }

      // Bound 3, and it has to be asked **before** the claim for a ticket-scoped
      // trigger, for the same reason the threshold above does. Claiming and then
      // recording `run_budget_exceeded` spends `ticket:{id}` — so a ticket that
      // happened to be busy in the hour its four-hour escalation came due would
      // record the refusal once and never escalate again, even after it went
      // quiet. The budget is a *rate* limit; it must not become a permanent one.
      if (keyIsSpendableOnce && (await budgetExceeded())) {
        // Nothing is claimed and nothing is written, so the next sweep re-offers
        // the ticket and the escalation happens late rather than never. Logged
        // rather than silent: the run list cannot carry this one, and a tenant
        // hitting it repeatedly is the support conversation the bound exists for.
        this.logger.warn(
          `Deferred ${trigger.triggerType} for ticket ${trigger.ticketId}: over ` +
            `${WORKFLOW_LIMITS.runsPerTicketPerHour} runs this hour. Its claim is left unspent, ` +
            'so it will be retried rather than lost.',
        );
        continue;
      }

      const runId = await this.claim(trigger, candidate, dedupeKey);

      if (runId === null) {
        continue;
      }

      claimed += 1;

      if (await budgetExceeded()) {
        // The event triggers land here, and for them a **failed run rather than
        // a silent drop** is right: their key is per-occurrence, so spending it
        // costs that one occurrence and nothing after it — and a supervisor with
        // a runaway workflow needs to find it in the run list rather than in our
        // logs.
        await this.finish(runId, 'failed', [], 'run_budget_exceeded', null);
        failed += 1;
        continue;
      }

      const outcome = await this.runOne(trigger, candidate, runId, factSheet);

      if (outcome === 'succeeded') {
        succeeded += 1;
      } else if (outcome === 'skipped') {
        skipped += 1;
      } else {
        failed += 1;
      }
    }

    return {
      candidates: candidates.length,
      claimed,
      succeeded,
      skipped,
      failed,
      chainDepthExceeded: false,
    };
  }

  /**
   * One claimed run: evaluate, then execute or record `skipped`.
   *
   * Everything a tenant can get wrong lands on the run row. The one exception is
   * a ticket that is not visible — that means the fact sheet could not be read at
   * all, and since the claim is already taken there is no point retrying the job:
   * the run is closed as `ticket_gone` and the job succeeds.
   */
  private async runOne(
    trigger: WorkflowEvaluateTicketTrigger,
    candidate: CandidateWorkflow,
    runId: string,
    factSheet: () => Promise<WorkflowFacts>,
  ): Promise<'succeeded' | 'skipped' | 'failed'> {
    try {
      const facts = await factSheet();

      if (!workflowMatches(candidate.definition.conditions, facts)) {
        // `skipped`, not `failed`: the run happened and matched nothing, which
        // is the answer to "why didn't my rule fire" — the question a supervisor
        // actually brings to the run list.
        await this.finish(runId, 'skipped', [], null, null);

        return 'skipped';
      }

      return await this.executeActions(trigger, candidate, runId);
    } catch (error: unknown) {
      if (error instanceof WorkflowTicketNotVisibleError) {
        await this.finish(runId, 'failed', [], 'ticket_gone', error.message);

        return 'failed';
      }

      this.logger.error(
        `Workflow ${candidate.id} run ${runId} failed on ticket ${trigger.ticketId}: ` +
          describeFailure(error),
      );
      await this.finish(runId, 'failed', [], 'internal_error', describeFailure(error));

      return 'failed';
    }
  }

  /**
   * The action list, in order, stopping at the first failure.
   *
   * Actions after a failure are recorded `skipped` rather than omitted, so the
   * run says "action 2 failed, action 3 never ran" instead of leaving the
   * supervisor to infer it from a short array.
   */
  private async executeActions(
    trigger: WorkflowEvaluateTicketTrigger,
    candidate: CandidateWorkflow,
    runId: string,
  ): Promise<'succeeded' | 'failed'> {
    const results: WorkflowActionResult[] = [];
    const chained: NonNullable<ActionOutcome['occurrence']>[] = [];
    let failure: WorkflowFailureReason | null = null;

    for (const [index, action] of candidate.definition.actions.entries()) {
      if (failure !== null) {
        results.push({ index, type: action.type, outcome: 'skipped', reason: null });
        continue;
      }

      const outcome = await this.executor.execute(action, {
        tenantId: trigger.tenantId,
        ticketId: trigger.ticketId,
        workflowId: candidate.id,
        workflowRunId: runId,
        actionIndex: index,
      });

      results.push({
        index,
        type: action.type,
        outcome: outcome.outcome,
        reason: outcome.reason,
      });

      if (outcome.occurrence !== null) {
        chained.push(outcome.occurrence);
      }

      if (outcome.outcome === 'failed') {
        failure = asFailureReason(outcome.reason);
      }
    }

    await this.finish(
      runId,
      failure === null ? 'succeeded' : 'failed',
      results,
      failure,
      failure === null ? null : describeFailedAction(results),
    );

    if (failure === 'reference_missing') {
      // 0009 decision 6, mechanism 4. Deactivating rather than skipping is the
      // whole point: a workflow that fails silently on every ticket for a week
      // is worse than one that stops and says so.
      await this.deactivate(trigger.tenantId, candidate.id, runId, trigger.ticketId);
    }

    // Raised after the run is closed, so a chained job cannot read a run row
    // that is still `running`.
    for (const occurrence of chained) {
      await this.raiseChainedTrigger(trigger, runId, occurrence);
    }

    return failure === null ? 'succeeded' : 'failed';
  }

  /**
   * The claim (0009, decision 2). **Only a run this statement inserted is
   * returned**, and therefore only it is executed.
   *
   * Raw SQL rather than `create().catch(P2002)` for two reasons. `ON CONFLICT DO
   * NOTHING` is one round trip where a caught unique violation is a round trip
   * plus an aborted transaction, and — the one that matters — a caught exception
   * cannot tell "another replica owns this" from a genuine constraint problem,
   * so the normal case would be indistinguishable from a fault in the logs.
   *
   * Every value is bound. `results` defaults to `'[]'` in the column, which is
   * why this statement does not name it and why `workflow_runs_results_is_array`
   * still holds for a row that was claimed and never finished.
   */
  private async claim(
    trigger: WorkflowEvaluateTicketTrigger,
    candidate: CandidateWorkflow,
    dedupeKey: string,
  ): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO workflow_runs (id, tenant_id, workflow_id, workflow_version, ticket_id,
                                 dedupe_key, status, trigger, started_at, created_at)
      VALUES (${randomUUID()}::uuid, ${trigger.tenantId}::uuid, ${candidate.id}::uuid,
              ${candidate.version}, ${trigger.ticketId}::uuid, ${dedupeKey}, 'running',
              ${JSON.stringify(trigger)}::jsonb, now(), now())
      ON CONFLICT (tenant_id, workflow_id, dedupe_key) DO NOTHING
      RETURNING id
    `;

    return rows[0]?.id ?? null;
  }

  /** Closes a run. One statement, and the only writer of a terminal status. */
  private async finish(
    runId: string,
    status: 'succeeded' | 'skipped' | 'failed',
    results: readonly WorkflowActionResult[],
    failureReason: WorkflowFailureReason | null,
    error: string | null,
  ): Promise<void> {
    await this.prisma.workflowRun.updateMany({
      where: { id: runId },
      data: {
        status,
        results: JSON.parse(JSON.stringify(results)) as Prisma.InputJsonValue,
        // `workflow_runs_failure_reason_only_when_failed` allows a null on a
        // `failed` row but never a reason on any other status, so this pair is
        // written together and never apart.
        failureReason,
        error,
        finishedAt: new Date(),
      },
    });
  }

  /**
   * Bound 3's counting read: how many runs this ticket has produced in the last
   * hour, across every workflow.
   *
   * Served by `workflow_runs (tenant_id, ticket_id, created_at DESC)` — the same
   * index behind "what automation touched this ticket". Counted once per job
   * rather than once per workflow, because the answer cannot change enough
   * within one job to matter and a per-workflow count would be 50 reads on a
   * tenant that is already misbehaving.
   */
  private async isOverRunBudget(ticketId: string): Promise<boolean> {
    const since = new Date(Date.now() - WORKFLOW_RUN_BUDGET_WINDOW_MS);
    const held = await this.prisma.workflowRun.count({
      where: { ticketId, createdAt: { gte: since } },
    });

    return held > WORKFLOW_LIMITS.runsPerTicketPerHour;
  }

  /**
   * Disarms a workflow whose reference went missing at evaluation time, and
   * tells the tenant's admins.
   *
   * `is_active = false` and `broken_reason = 'reference_missing'` in one
   * statement — `workflows_broken_is_inactive` requires exactly that pairing.
   * The dangling id stays in the definition on purpose, so the response reports
   * `exists: false` and the console shows precisely which field needs a new
   * value.
   *
   * The audit row carries a null actor: nobody did this, the engine did.
   */
  private async deactivate(
    tenantId: string,
    workflowId: string,
    runId: string,
    ticketId: string,
  ): Promise<void> {
    await this.prisma.$tenantTransaction(async (tx) => {
      const { count } = await tx.workflow.updateMany({
        where: { id: workflowId, isActive: true },
        data: { isActive: false, brokenReason: 'reference_missing' },
      });

      if (count === 0) {
        // Somebody else already disarmed it — a concurrent run, or a supervisor
        // who saw the first failure. Not a second incident.
        return;
      }

      const admins = await tx.user.findMany({
        where: { role: UserRole.admin, status: UserStatus.active },
        select: { id: true },
      });

      if (admins.length > 0) {
        await tx.notification.createMany({
          data: admins.map((admin) => ({
            // Named explicitly: `$tenantTransaction` hands back the
            // **un-extended** client, so nothing injects it, and
            // `notifications.tenant_id` is `NOT NULL`.
            tenantId,
            type: 'workflow_broken' as const,
            ticketId,
            recipientUserId: admin.id,
            data: { workflowId, workflowRunId: runId },
            // One "this workflow is broken" per admin, ever — not one per
            // ticket that trips over it. `UNIQUE (tenant_id,
            // recipient_user_id, dedupe_key)` is what enforces that, and it is
            // why the key names the workflow rather than the run.
            dedupeKey: `workflow-broken:${workflowId}`,
          })),
          skipDuplicates: true,
        });
      }

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.workflowDeactivated,
        targetType: 'workflow',
        targetId: workflowId,
        metadata: { reason: 'reference_missing', workflowRunId: runId },
      });
    });

    this.logger.warn(
      `Workflow ${workflowId} was deactivated: run ${runId} named a tag, team or user that no ` +
        'longer exists.',
    );
  }

  /**
   * A workflow's own write is a triggering occurrence like any other — carrying
   * its cause's `depth + 1` and the run that caused it.
   *
   * This is what makes bound 1 (the dedupe key) and bound 2 (`depth`) compose:
   * a workflow can never fire twice for the same occurrence, so it cannot
   * trigger *itself* directly, and a two-rule cycle stops after three hops.
   * Legitimate chains — "escalation reassigns it, a second rule notifies the new
   * team" — survive.
   */
  private async raiseChainedTrigger(
    cause: WorkflowEvaluateTicketTrigger,
    runId: string,
    occurrence: {
      triggerType: WorkflowEvaluateTicketTrigger['triggerType'];
      ticketEventId: string;
    },
  ): Promise<void> {
    const chained: WorkflowEvaluateTicketTrigger = {
      tenantId: cause.tenantId,
      ticketId: cause.ticketId,
      triggerType: occurrence.triggerType,
      occurrenceId: occurrence.ticketEventId,
      depth: cause.depth + 1,
      causedByRunId: runId,
    };

    const outcome = await this.queue.enqueue<WorkflowEvaluateTicketTrigger>(
      WORKFLOWS_QUEUE,
      WORKFLOW_EVALUATE_TICKET_JOB,
      chained,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Run ${runId} raised ${occurrence.triggerType} on ticket ${cause.ticketId} but the ` +
          `chained evaluation was not queued (${outcome}).`,
      );
    }
  }
}

/**
 * The executor's `reason` string, narrowed back to the published enum.
 *
 * It comes back as a `string` because `WorkflowActionResult.reason` is a plain
 * string — it carries a failure reason on `failed` and could carry other detail
 * later. Anything unrecognised becomes `internal_error`, which is the honest
 * answer: the run failed for a reason this build cannot name.
 */
function asFailureReason(reason: string | null): WorkflowFailureReason {
  switch (reason) {
    case 'reference_missing':
    case 'transition_refused':
    case 'ticket_gone':
    case 'run_budget_exceeded':
      return reason;
    default:
      return 'internal_error';
  }
}

/** The human-readable half behind `failure_reason`, naming the action that stopped the list. */
function describeFailedAction(results: readonly WorkflowActionResult[]): string {
  const failed = results.find((result) => result.outcome === 'failed');

  return failed === undefined
    ? 'An action failed.'
    : `Action ${failed.index} (${failed.type}) failed: ${failed.reason ?? 'unknown'}.`;
}
