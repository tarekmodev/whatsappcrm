import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  AI_HANDLE_INBOUND_JOB,
  AI_INDEX_DOCUMENT_JOB,
  AI_QUEUE,
  BotInboundTriggerSchema,
  IndexKnowledgeDocumentJobSchema,
} from '@whatsappcrm/contracts';
import { UnrecoverableError } from 'bullmq';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { QueueService, type TenantJobData } from '../queue/queue.service';
import { AI_WORKER_CONCURRENCY } from './ai.constants';
import { BotTurnService } from './bot-turn.service';
import { KnowledgeIndexerService } from './knowledge-indexer.service';

/**
 * Where the bot meets BullMQ, and the only file in this module that knows a
 * queue exists.
 *
 * The same arrangement as `TicketQueueRunner` and `SlaQueueRunner`, for the same
 * reason: keeping the wiring here means `BotTurnService`, `BotEligibilityService`
 * and `KnowledgeIndexerService` stay plain classes a unit test calls directly —
 * no queue, no Redis, no framework — which is what makes the confidence gate and
 * every handoff reason testable at all.
 *
 * Registration happens on application bootstrap rather than in a constructor, so
 * a worker never starts before the providers it dispatches into resolve.
 *
 * ## The payload is treated as unvalidated input
 *
 * Because that is what it is: JSON read back out of Redis, possibly written by
 * an older deploy. A malformed one is `UnrecoverableError` — no number of
 * retries changes the shape of a payload that is already in Redis, so it goes
 * straight to the failed set, which is the thing being monitored.
 */
@Injectable()
export class AiQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiQueueRunner.name);

  constructor(
    private readonly queue: QueueService,
    private readonly turns: BotTurnService,
    private readonly indexer: KnowledgeIndexerService,
  ) {}

  onApplicationBootstrap(): void {
    const started = this.queue.registerWorker<TenantJobData>({
      queue: AI_QUEUE,
      concurrency: AI_WORKER_CONCURRENCY,
      handlers: {
        [AI_HANDLE_INBOUND_JOB]: async (job) => {
          await this.handleInbound(job.data);
        },
        [AI_INDEX_DOCUMENT_JOB]: async (job) => {
          await this.indexDocument(job.data);
        },
      },
    });

    if (!started) {
      // Said once, loudly, at boot. Messages still land in the inbox, tickets
      // still open and humans still answer — the product degrades to exactly its
      // pre-TAR-28 behaviour. But no knowledge-base document is ever indexed, so
      // an admin who saves one and watches it sit `pending` deserves to know why.
      this.logger.warn(
        'No AI worker started: the chatbot will not answer and knowledge base documents will ' +
          'stay pending until REDIS_URL is set.',
      );
    }
  }

  /**
   * One turn.
   *
   * The tenant scope every statement below runs in was opened by `QueueService`
   * from `job.data.tenantId` before this was called, which is why nothing here
   * touches `TenantContextService`: a worker that opened its own scope would be
   * a second place the rule lives, and the one that forgot would be the leak.
   */
  private async handleInbound(data: unknown): Promise<void> {
    const parsed = BotInboundTriggerSchema.safeParse(data);

    if (!parsed.success) {
      throw new UnrecoverableError(
        `Malformed ${AI_HANDLE_INBOUND_JOB} payload: ${parsed.error.message}`,
      );
    }

    const trigger = parsed.data;

    try {
      const outcome = await this.turns.handle(trigger);

      this.logger.debug(`Bot turn for message ${trigger.messageId}: ${outcome}.`);
    } catch (error: unknown) {
      if (error instanceof TenantNotActiveError) {
        // Non-retryable, and discarded rather than failed — the same handling
        // `TicketQueueRunner` gives it. Deactivation retains data and revokes
        // access (TAR-51), so this is a state an operator created rather than a
        // fault to alert on.
        this.logger.warn(`Bot turn for message ${trigger.messageId} dropped: ${error.message}`);
        return;
      }

      // Everything else is retryable by contract — most often a job that
      // overtook the transaction that wrote its message. Rethrown so BullMQ
      // applies its backoff, and so an exhausted budget lands in the failed set.
      //
      // Note what this does *not* do: it does not hand the conversation off. A
      // provider failure is already a handoff inside `BotTurnService`, which is
      // where the customer-facing decision belongs; what reaches here is a
      // database or wiring fault, and inventing a handoff for it would write a
      // customer-visible event on the way to a bug report.
      throw error;
    }
  }

  private async indexDocument(data: unknown): Promise<void> {
    const parsed = IndexKnowledgeDocumentJobSchema.safeParse(data);

    if (!parsed.success) {
      throw new UnrecoverableError(
        `Malformed ${AI_INDEX_DOCUMENT_JOB} payload: ${parsed.error.message}`,
      );
    }

    const { documentId } = parsed.data;

    try {
      await this.indexer.index(documentId);
    } catch (error: unknown) {
      if (error instanceof TenantNotActiveError) {
        this.logger.warn(`Indexing of knowledge document ${documentId} dropped: ${error.message}`);
        return;
      }

      throw error;
    }
  }
}
