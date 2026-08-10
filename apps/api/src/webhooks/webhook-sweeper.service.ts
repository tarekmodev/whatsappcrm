import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PROCESS_WEBHOOK_EVENT_JOB, WEBHOOKS_QUEUE } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { WebhookEventsRepository } from './webhook-events.repository';
import { processWebhookEventJobId, type ProcessWebhookEventJob } from './webhook-jobs';

/**
 * How many stuck events one sweep re-enqueues.
 *
 * Bounded on purpose. After an outage the backlog can be arbitrarily large, and
 * a sweep that tried to load all of it would hold a long transaction and then
 * flood the queue in one burst. Oldest first, capped, every interval: the
 * backlog drains in arrival order across several sweeps.
 */
const SWEEP_BATCH_SIZE = 200;

/**
 * The single most valuable property in the ingestion design: this is what makes
 * a Redis outage message *lateness* rather than message *loss*.
 *
 * ADR 0001 put both realtime and the queue on Redis. The ingest controller
 * therefore stores to Postgres and answers Meta before it enqueues, and this job
 * closes the loop — anything still `received` (never enqueued, or enqueued into
 * a Redis that was not there) or stuck in `processing` (a worker that died
 * mid-job, a lock that expired) is put back on the queue.
 *
 * Re-enqueueing is safe because processing is idempotent: the claim in
 * `WebhookEventsRepository` hands the row to exactly one worker, and every write
 * downstream is an upsert or a guarded update.
 *
 * It is itself a BullMQ job rather than a `@Cron`, which is what stops it
 * running once per replica: BullMQ's scheduler is the distributed lock.
 */
@Injectable()
export class WebhookSweeperService {
  private readonly logger = new Logger(WebhookSweeperService.name);
  private readonly stuckAfterMs: number;
  private readonly maxAttempts: number;

  constructor(
    config: ConfigService,
    private readonly events: WebhookEventsRepository,
    private readonly queue: QueueService,
  ) {
    this.stuckAfterMs = config.getOrThrow<number>('WEBHOOK_STUCK_AFTER_MS');
    this.maxAttempts = config.getOrThrow<number>('WEBHOOK_MAX_ATTEMPTS');
  }

  /** Returns how many events were re-enqueued, for the log line and the tests. */
  async sweep(now: Date = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - this.stuckAfterMs);
    const stale = await this.events.findStale(staleBefore, SWEEP_BATCH_SIZE);

    if (stale.length === 0) {
      return 0;
    }

    let requeued = 0;

    for (const webhookEventId of stale) {
      const job: ProcessWebhookEventJob = { tenantId: null, webhookEventId };

      const queued = await this.queue.enqueue(WEBHOOKS_QUEUE, PROCESS_WEBHOOK_EVENT_JOB, job, {
        jobId: processWebhookEventJobId(webhookEventId),
        attempts: this.maxAttempts,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      });

      if (queued) {
        requeued += 1;
      }
    }

    // Worth a log line every time it does something: a sweep that finds work is
    // either recovery in progress or a worker that is not keeping up, and both
    // are things an operator wants to see without turning on debug logging.
    this.logger.log(`Re-enqueued ${requeued} of ${stale.length} stuck webhook events`);

    return requeued;
  }
}
