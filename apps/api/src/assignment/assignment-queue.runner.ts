import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  ASSIGNMENT_QUEUE,
  ASSIGNMENT_ROUTE_JOB,
  TICKET_ROUTER,
  TicketRoutingTriggerSchema,
  type TicketRouter,
  type TicketRoutingTrigger,
} from '@whatsappcrm/contracts';
import { UnrecoverableError } from 'bullmq';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { QueueService } from '../queue/queue.service';

/**
 * Where routing meets BullMQ, and the only file in this module that knows a
 * queue exists.
 *
 * The same arrangement as `TicketQueueRunner`, for the same reason: keeping the
 * wiring here rather than decorating the service means `RuleEngineService` stays
 * a plain class a unit test calls directly — no queue, no Redis, no framework —
 * which is what makes the evaluation-order and fallback cases testable at all.
 *
 * Registration happens on application bootstrap rather than in a constructor, so
 * a worker never starts before the providers it dispatches into resolve.
 */
@Injectable()
export class AssignmentQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(AssignmentQueueRunner.name);

  constructor(
    private readonly queue: QueueService,
    @Inject(TICKET_ROUTER) private readonly router: TicketRouter,
  ) {}

  onApplicationBootstrap(): void {
    const started = this.queue.registerWorker<TicketRoutingTrigger>({
      queue: ASSIGNMENT_QUEUE,
      // The repo default of one, left explicit rather than tuned. Routing is a
      // handful of indexed reads and one small transaction per ticket, and the
      // write is a compare-and-set, so parallelism is safe — it is simply not
      // yet known to be needed. Raise on the evaluation-duration measurement
      // 0007 asks TAR-290 to take at the rule cap.
      concurrency: 1,
      handlers: {
        [ASSIGNMENT_ROUTE_JOB]: async (job) => {
          await this.route(job.data);
        },
      },
    });

    if (!started) {
      // Said once, loudly, at boot. Tickets are still created and still visible
      // — routing is the part that stops, so every new ticket lands unassigned
      // and a supervisor sees a queue nobody is picking up.
      this.logger.warn(
        'No assignment worker started: tickets will be created but will not be routed by rule ' +
          'or by rotation until REDIS_URL is set.',
      );
    }
  }

  /**
   * One trigger, validated and routed.
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
  private async route(data: unknown): Promise<void> {
    const parsed = TicketRoutingTriggerSchema.safeParse(data);

    if (!parsed.success) {
      // Unrecoverable because no number of retries changes the shape of a
      // payload that is already in Redis. It goes straight to the failed set,
      // which is the thing being monitored, instead of spending five attempts
      // first.
      throw new UnrecoverableError(
        `Malformed ${ASSIGNMENT_ROUTE_JOB} payload: ${parsed.error.message}`,
      );
    }

    const trigger = parsed.data;

    try {
      const result = await this.router.routeTicket(trigger);

      // The outcome and the rule id, never the text that matched: keyword
      // matching reads a message body in memory and no log line carries it
      // (0007, security).
      this.logger.debug(
        `Ticket ${trigger.ticketId} ${result.outcome}` +
          (result.ruleId === null ? '' : ` by rule ${result.ruleId}`) +
          (result.reason === null ? '' : ` (${result.reason})`),
      );
    } catch (error: unknown) {
      if (error instanceof TenantNotActiveError) {
        // Non-retryable, and discarded rather than failed. Deactivation retains
        // data and revokes access (TAR-51), so this is a state an operator
        // deliberately created rather than a fault to alert on. The ticket is
        // untouched and can be routed if the tenant is ever reactivated.
        this.logger.warn(`Routing for ticket ${trigger.ticketId} dropped: ${error.message}`);
        return;
      }

      // Everything else is retryable by contract — most often a job that
      // overtook the transaction that wrote its ticket. Rethrown so BullMQ
      // applies its backoff, and so an exhausted budget lands in the failed set.
      throw error;
    }
  }
}
