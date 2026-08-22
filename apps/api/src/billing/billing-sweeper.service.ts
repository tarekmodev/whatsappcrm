import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BILLING_QUEUE, PROCESS_BILLING_EVENT_JOB } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { WebhookEventsRepository } from '../webhooks/webhook-events.repository';
import { BILLING_WEBHOOK_PROVIDER, sweptBillingEventJobId } from './billing.constants';
import type { ProcessBillingEventJob } from './billing-jobs';

/**
 * How many stuck events one sweep re-enqueues. Bounded for the reason
 * `WebhookSweeperService` gives: after an outage the backlog can be arbitrarily
 * large, and a sweep that loaded all of it would flood the queue in one burst.
 */
const SWEEP_BATCH_SIZE = 200;

/**
 * What turns a Redis outage into billing events arriving *late* rather than not
 * at all.
 *
 * The ingest path stores to Postgres and answers the provider before it
 * enqueues, so anything still `received` (never enqueued, or enqueued into a
 * Redis that was not there) or stuck in `processing` (a worker that died
 * mid-job, a lock that expired) is put back on the queue here.
 *
 * Re-enqueueing is safe because processing is idempotent twice over: the
 * status-scoped claim in `WebhookEventsRepository` hands the row to exactly one
 * worker, and `subscriptions.last_event_at` drops an event that has already been
 * applied.
 *
 * ## Why this is not `WebhookSweeperService`
 *
 * Both drain `webhook_events`, and for a while they could have been one class.
 * They cannot now: each provider has its own worker on its own queue, and a
 * BullMQ worker fails loudly on a job name its handler map does not carry — so
 * an unfiltered sweep would hand a Polar payload to `WhatsAppEventProcessor`,
 * which would park every one of them. Hence the `provider` argument on
 * `findStale`, and hence two small sweepers rather than one that has to know
 * which queue each row belongs on.
 *
 * It is a BullMQ job rather than a `@Cron`, which is what stops it running once
 * per replica: BullMQ's scheduler is the distributed lock.
 */
@Injectable()
export class BillingSweeperService {
  private readonly logger = new Logger(BillingSweeperService.name);
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
    const stale = await this.events.findStale(
      BILLING_WEBHOOK_PROVIDER,
      staleBefore,
      SWEEP_BATCH_SIZE,
    );

    if (stale.length === 0) {
      return 0;
    }

    let requeued = 0;

    for (const webhookEventId of stale) {
      const job: ProcessBillingEventJob = { tenantId: null, webhookEventId };

      const outcome = await this.queue.enqueue(BILLING_QUEUE, PROCESS_BILLING_EVENT_JOB, job, {
        // Not the ingest path's deterministic id: that one may still be held by
        // a failed job `removeOnFail` retains, and BullMQ ignores an `add` for
        // an id it holds. See `sweptBillingEventJobId`.
        jobId: sweptBillingEventJobId(webhookEventId, now),
        // The extra read is worth it here: this count is a recovery report, and
        // a duplicate counted as a re-enqueue is the log line lying about how
        // much of a backlog was actually recovered.
        detectDuplicate: true,
        attempts: this.maxAttempts,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      });

      if (outcome === 'added') {
        requeued += 1;
      }
    }

    // Worth a line every time it finds work: a billing sweep that finds
    // something is either recovery in progress or a worker that is not keeping
    // up, and both are things an operator wants to see without turning on debug
    // logging. It counts jobs actually created, not calls made.
    this.logger.log(`Re-enqueued ${requeued} of ${stale.length} stuck billing events`);

    return requeued;
  }
}
