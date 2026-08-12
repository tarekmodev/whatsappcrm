import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  InboundMessageTicketTriggerSchema,
  TICKET_ENSURE_JOB,
  TICKET_LINKER,
  TICKET_QUEUE,
  type InboundMessageTicketTrigger,
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
}
