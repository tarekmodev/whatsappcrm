import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SLA_EVALUATE_TICKET_JOB,
  SLA_QUEUE,
  SLA_SWEEP_JOB,
  SlaEvaluateTicketTriggerSchema,
  type SlaEvaluateTicketTrigger,
} from '@whatsappcrm/contracts';
import { UnrecoverableError } from 'bullmq';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { QueueService } from '../queue/queue.service';
import { SLA_SWEEP_SCHEDULE_KEY, SLA_WORKER_CONCURRENCY } from './sla.constants';
import { SlaSweepService } from './sla-sweep.service';
import { SlaTimerService } from './sla-timer.service';

/**
 * Where the SLA mechanism meets BullMQ, and the only file in this module that
 * knows a queue exists.
 *
 * The same arrangement as `WebhookQueueRunner` and `TicketQueueRunner`, for the
 * same reason: keeping the wiring here means `SlaTimerService` and
 * `SlaSweepService` stay plain classes a unit test calls directly — no queue, no
 * Redis, no framework — which is what makes the idempotency and boundary cases
 * testable at all.
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
 * spending five attempts first.
 */
@Injectable()
export class SlaQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(SlaQueueRunner.name);

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly timers: SlaTimerService,
    private readonly sweep: SlaSweepService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const started = this.queue.registerWorker<SlaEvaluateTicketTrigger>({
      queue: SLA_QUEUE,
      // Above the repo default of one, and this is the one place in the codebase
      // where that default is actively wrong. The sweep and the per-ticket
      // evaluations share this queue, and a sweep walking several slow tenants
      // holds its slot for tens of seconds — during which every
      // `sla.evaluate-ticket` job queues behind it. Because the sweep re-checks
      // `due_at <= now()` when it claims, an evaluation stuck behind a long
      // sweep can let a ticket breach whose agent had already replied: a false
      // alert, by a narrower route than the one that made the job id a bug.
      //
      // Concurrency rather than a second queue: the work is short and
      // database-bound, the reconciler is safe to run concurrently with itself
      // (every transition is a guarded conditional update), and a queue of its
      // own would be a second scheduler key and a second failed set to monitor
      // for no gain the arithmetic supports. Revisit if a sweep ever saturates
      // all four.
      concurrency: SLA_WORKER_CONCURRENCY,
      handlers: {
        [SLA_EVALUATE_TICKET_JOB]: async (job) => {
          await this.evaluateTicket(job.data);
        },
        [SLA_SWEEP_JOB]: async () => {
          await this.sweep.sweep();
        },
      },
    });

    if (!started) {
      // Said once, loudly, at boot. Tickets are still created and still
      // answered; nothing is lost, and the first sweep after Redis returns
      // drains the whole backlog because the predicate is `due_at <= now()`.
      // But until then no timer is started and no supervisor is alerted, and a
      // supervisor looking at an empty alert list deserves to know why.
      this.logger.warn(
        'No SLA worker started: timers will not be started and no breach will be detected ' +
          'until REDIS_URL is set.',
      );
      return;
    }

    await this.queue.schedule(
      SLA_QUEUE,
      SLA_SWEEP_JOB,
      // Tenant-less by design: the sweep's phase 1 spans every tenant, and each
      // tenant's phase 2 opens a scope of its own from the ids it found.
      { tenantId: null },
      {
        key: SLA_SWEEP_SCHEDULE_KEY,
        everyMs: this.config.getOrThrow<number>('SLA_SWEEP_INTERVAL_MS'),
      },
    );
  }

  private async evaluateTicket(data: unknown): Promise<void> {
    const parsed = SlaEvaluateTicketTriggerSchema.safeParse(data);

    if (!parsed.success) {
      throw new UnrecoverableError(
        `Malformed ${SLA_EVALUATE_TICKET_JOB} payload: ${parsed.error.message}`,
      );
    }

    const trigger = parsed.data;

    try {
      const summary = await this.timers.evaluate(trigger);

      this.logger.debug(
        `Ticket ${trigger.ticketId} evaluated (${trigger.reason}): ` +
          `${summary.created} timer(s) started, ${summary.transitioned} moved` +
          (summary.firstResponseStamped ? ', first response recorded' : ''),
      );
    } catch (error: unknown) {
      if (error instanceof TenantNotActiveError) {
        // Non-retryable, and discarded rather than failed — the same handling
        // `TicketQueueRunner` gives it. Deactivation retains data and revokes
        // access (TAR-51), so this is a state an operator created rather than a
        // fault to alert on, and spending the retry budget on a tenant that is
        // gone helps nobody.
        this.logger.warn(`SLA evaluation for ticket ${trigger.ticketId} dropped: ${error.message}`);
        return;
      }

      // Everything else is retryable by contract — most often a job that
      // overtook the transaction that wrote its ticket. Rethrown so BullMQ
      // applies its backoff, and so an exhausted budget lands in the failed set.
      throw error;
    }
  }
}
