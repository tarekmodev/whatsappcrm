import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WORKFLOWS_QUEUE,
  WORKFLOW_EVALUATE_TICKET_JOB,
  WORKFLOW_SWEEP_JOB,
  WorkflowEvaluateTicketTriggerSchema,
  type WorkflowEvaluateTicketTrigger,
} from '@whatsappcrm/contracts';
import { UnrecoverableError } from 'bullmq';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { QueueService } from '../queue/queue.service';
import { WorkflowElapsedSweep } from './workflow-elapsed.sweep';
import { WorkflowTriggerService } from './workflow-trigger.service';
import { WORKFLOW_SWEEP_SCHEDULE_KEY, WORKFLOW_WORKER_CONCURRENCY } from './workflows.constants';

/**
 * Where the workflow engine meets BullMQ, and the only file in this module that
 * knows a queue exists.
 *
 * The same arrangement as `SlaQueueRunner` and `TicketQueueRunner`, for the same
 * reason: keeping the wiring here means `WorkflowTriggerService` and
 * `WorkflowElapsedSweep` stay plain classes a unit test calls directly — no
 * queue, no Redis, no framework — which is what makes the claim and the
 * threshold cases testable at all.
 *
 * Registration happens on application bootstrap rather than in a constructor, so
 * a worker never starts before the providers it dispatches into resolve.
 *
 * ## The payload is treated as unvalidated input
 *
 * Because that is what it is: JSON read back out of Redis, possibly written by
 * an older deploy. A malformed one is `UnrecoverableError` — no number of
 * retries changes the shape of a payload that is already in Redis, so it goes
 * straight to the failed set, which is the thing being monitored, instead of
 * spending three attempts first.
 *
 * Every id in it is re-read in tenant scope by the handler rather than trusted.
 * The worker sets that scope from `job.data.tenantId` before its first statement
 * — `QueueService.runInTenantScope` does it, so nothing here has to remember.
 */
@Injectable()
export class WorkflowQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkflowQueueRunner.name);

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly triggers: WorkflowTriggerService,
    private readonly sweep: WorkflowElapsedSweep,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const started = this.queue.registerWorker<WorkflowEvaluateTicketTrigger>({
      queue: WORKFLOWS_QUEUE,
      concurrency: WORKFLOW_WORKER_CONCURRENCY,
      handlers: {
        [WORKFLOW_EVALUATE_TICKET_JOB]: async (job) => {
          await this.evaluateTicket(job.data);
        },
        [WORKFLOW_SWEEP_JOB]: async () => {
          await this.sweep.sweep();
        },
      },
    });

    if (!started) {
      // Said once, loudly, at boot. Tickets are still created and still
      // answered, and nothing durable is lost for elapsed triggers — the first
      // sweep after Redis returns re-derives the whole backlog from
      // `created_at`. But until then no automation runs at all, and a supervisor
      // looking at a rule that never fires deserves to know why.
      this.logger.warn(
        'No workflow worker started: no automation will run and no escalation will be raised ' +
          'until REDIS_URL is set.',
      );
      return;
    }

    await this.queue.schedule(
      WORKFLOWS_QUEUE,
      WORKFLOW_SWEEP_JOB,
      // Tenant-less by design: the sweep's phase 1 spans every tenant, and each
      // job it raises names the tenant it is for.
      { tenantId: null },
      {
        key: WORKFLOW_SWEEP_SCHEDULE_KEY,
        everyMs: this.config.getOrThrow<number>('WORKFLOW_SWEEP_INTERVAL_MS'),
      },
    );
  }

  private async evaluateTicket(data: unknown): Promise<void> {
    const parsed = WorkflowEvaluateTicketTriggerSchema.safeParse(data);

    if (!parsed.success) {
      throw new UnrecoverableError(
        `Malformed ${WORKFLOW_EVALUATE_TICKET_JOB} payload: ${parsed.error.message}`,
      );
    }

    const trigger = parsed.data;

    try {
      const report = await this.triggers.evaluate(trigger);

      if (report.claimed === 0) {
        // The common case for a redelivery, and deliberately quiet: a duplicate
        // delivery is normal, not an incident.
        return;
      }

      this.logger.debug(
        `Ticket ${trigger.ticketId} evaluated (${trigger.triggerType}): ${report.claimed} run(s) ` +
          `claimed of ${report.candidates} candidate(s) — ${report.succeeded} succeeded, ` +
          `${report.skipped} skipped, ${report.failed} failed`,
      );
    } catch (error: unknown) {
      if (error instanceof TenantNotActiveError) {
        // Non-retryable, and discarded rather than failed — the handling
        // `SlaQueueRunner` and `TicketQueueRunner` both give it. Deactivation
        // retains data and revokes access, so this is a state an operator
        // created rather than a fault to alert on.
        this.logger.warn(
          `Workflow evaluation for ticket ${trigger.ticketId} dropped: ${error.message}`,
        );
        return;
      }

      // Everything else is retryable by contract — most often a job that
      // overtook the transaction that wrote its ticket. Rethrown so BullMQ
      // applies its backoff, and so an exhausted budget lands in the failed set,
      // which by construction contains only infrastructure faults: every
      // tenant-caused failure is a `failed` run row, never a failed job.
      throw error;
    }
  }
}
