import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  InboundMessageTicketTriggerSchema,
  SLA_EVALUATE_TICKET_JOB,
  SLA_QUEUE,
  TICKET_ENSURE_JOB,
  TICKET_LINKER,
  TICKET_QUEUE,
  slaEvaluateJobId,
  type InboundMessageTicketTrigger,
  type SlaEvaluateReason,
  type SlaEvaluateTicketTrigger,
  type TicketLinkResult,
  type TicketLinker,
} from '@whatsappcrm/contracts';
import { UnrecoverableError } from 'bullmq';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { QueueService } from '../queue/queue.service';

/**
 * Where auto-ticketing meets BullMQ, and the only file in this module that knows
 * a queue exists.
 *
 * The same arrangement as `WebhookQueueRunner` and `MediaQueueRunner`, for the
 * same reason: keeping the wiring here rather than decorating the service means
 * `TicketLinkerService` stays a plain class a unit test calls directly — no
 * queue, no Redis, no framework — which is what made TAR-75's race and
 * idempotency cases testable before this runner existed at all.
 *
 * Registration happens on application bootstrap rather than in a constructor, so
 * a worker never starts before the providers it dispatches into resolve.
 */
@Injectable()
export class TicketQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(TicketQueueRunner.name);

  constructor(
    private readonly queue: QueueService,
    @Inject(TICKET_LINKER) private readonly linker: TicketLinker,
  ) {}

  onApplicationBootstrap(): void {
    const started = this.queue.registerWorker<InboundMessageTicketTrigger>({
      queue: TICKET_QUEUE,
      // The repo default of one, left explicit rather than tuned. 0003 names a
      // convoy on `ticket_counters` as the known cost of the create path — two
      // messages from the same contact can briefly queue every other ticket
      // creation in that tenant behind them — so parallelism here buys less than
      // it looks like it does, and the document's own next step is an advisory
      // lock rather than a wider worker. Raise on evidence from TAR-78.
      concurrency: 1,
      handlers: {
        [TICKET_ENSURE_JOB]: async (job) => {
          await this.ensureTicket(job.data);
        },
      },
    });

    if (!started) {
      // Said once, loudly, at boot. Inbound messages still land in the inbox and
      // nothing is lost — but no conversation becomes a ticket until a process
      // with Redis picks the queue up, and an agent looking at a ticket list
      // would see an empty one while the inbox filled.
      this.logger.warn(
        'No ticket worker started: inbound messages will land in the inbox but will not open ' +
          'tickets until REDIS_URL is set.',
      );
    }
  }

  /**
   * One trigger, validated and linked.
   *
   * The tenant scope every statement below runs in was opened by `QueueService`
   * from `job.data.tenantId` before this was called, which is why nothing here
   * touches `TenantContextService`: a worker that opened its own scope would be
   * a second place the rule lives, and the one that forgot would be the leak.
   *
   * The payload is treated as unvalidated input rather than as the type the
   * generic claims, because that is what it is — JSON read back out of Redis,
   * possibly written by an older deploy.
   */
  private async ensureTicket(data: unknown): Promise<void> {
    const parsed = InboundMessageTicketTriggerSchema.safeParse(data);

    if (!parsed.success) {
      // 0003: a malformed payload fails loudly rather than writing garbage.
      // Unrecoverable because no number of retries changes the shape of a
      // payload that is already in Redis — it goes straight to the failed set,
      // which is the thing being monitored, instead of spending five attempts
      // first.
      throw new UnrecoverableError(
        `Malformed ${TICKET_ENSURE_JOB} payload: ${parsed.error.message}`,
      );
    }

    const trigger = parsed.data;

    try {
      const result = await this.linker.ensureTicketForMessage(trigger);

      this.logger.debug(
        `Message ${trigger.messageId} ${result.outcome}` +
          (result.ticketNumber === null ? '' : ` ticket #${result.ticketNumber}`),
      );

      await this.triggerSlaEvaluation(trigger.tenantId, result);
    } catch (error: unknown) {
      if (error instanceof TenantNotActiveError) {
        // 0003's error table: non-retryable, and discarded rather than failed.
        // Deactivation retains data and revokes access (TAR-51), so this is a
        // state an operator deliberately created rather than a fault to alert
        // on — and spending the retry budget on a tenant that is gone helps
        // nobody. The message itself is untouched and the ticket can be opened
        // if the tenant is ever reactivated.
        this.logger.warn(
          `Ticket trigger for message ${trigger.messageId} dropped: ${error.message}`,
        );
        return;
      }

      // Everything else is retryable by contract — most often a job that
      // overtook the transaction that wrote its message. Rethrown so BullMQ
      // applies its backoff, and so an exhausted budget lands in the failed set.
      throw error;
    }
  }

  /**
   * Two of 0006's four SLA triggers, both produced here (TAR-26).
   *
   * A ticket that was **created** needs its timers started; one that was
   * **attached to while `pending`** has just had the customer reply, which is
   * the cue to resume a paused timer. `previousStatus` carries that fact out of
   * the linker precisely so this does not have to re-read the row.
   *
   * An `attached` on an already-open ticket enqueues nothing: nothing about the
   * SLA changed, and a job per inbound message on a busy thread would be a
   * reconciliation that always finds the same state.
   *
   * ## Why here rather than inside `TicketLinkerService`
   *
   * This runner is documented as the only file in the module that knows a queue
   * exists, and that is what keeps the linker a plain class a unit test calls
   * directly. It also keeps the enqueue outside the linker's transaction, which
   * is where it has to be: a job that reached a worker before the ticket
   * committed would read no ticket and burn a retry.
   *
   * Failure to enqueue is logged, never thrown. The ticket is committed, and
   * throwing would have BullMQ retry `ticket.ensure-for-message` — re-running
   * the linker to fix an SLA job, which is the wrong repair. The honest
   * limitation, stated rather than glossed: nothing re-enqueues a lost
   * evaluation today. A ticket whose trigger was lost gets no timers until
   * something else evaluates it, which is a narrower gap than it sounds — the
   * customer's next message produces another trigger — but it is a real one, and
   * a sweep for ticket-with-no-timer is this story's recorded follow-up.
   */
  private async triggerSlaEvaluation(tenantId: string, result: TicketLinkResult): Promise<void> {
    const reason = slaReasonFor(result);

    if (reason === null || result.ticketId === null) {
      return;
    }

    const trigger: SlaEvaluateTicketTrigger = { tenantId, ticketId: result.ticketId, reason };

    const outcome = await this.queue.enqueue<SlaEvaluateTicketTrigger>(
      SLA_QUEUE,
      SLA_EVALUATE_TICKET_JOB,
      trigger,
      {
        jobId: slaEvaluateJobId(trigger),
        // Retried, because the ticket is durable and the timer is owed: a job
        // that overtook its own transaction succeeds on the next attempt.
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Ticket ${result.ticketId} was linked but its SLA evaluation was not queued (${outcome}); ` +
          'no timer will be started until it is evaluated again.',
      );
    }
  }
}

/** Which of 0006's reasons this link outcome is, or `null` when it is none of them. */
function slaReasonFor(result: TicketLinkResult): SlaEvaluateReason | null {
  if (result.outcome === 'created') {
    return 'ticket_created';
  }

  return result.outcome === 'attached' && result.previousStatus === 'pending'
    ? 'customer_replied'
    : null;
}
