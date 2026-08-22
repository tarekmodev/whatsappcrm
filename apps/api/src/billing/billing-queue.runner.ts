import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BILLING_QUEUE,
  PROCESS_BILLING_EVENT_JOB,
  RECONCILE_BILLING_JOB,
  SWEEP_BILLING_EVENTS_JOB,
  SYNC_BILLING_SEATS_JOB,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { BillingEventProcessor } from './billing-event.processor';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { BillingSweeperService } from './billing-sweeper.service';
import { SeatSyncService } from './seat-sync.service';
import type { ProcessBillingEventJob, SyncBillingSeatsJob } from './billing-jobs';

/** Stable ids for the repeatables, so a redeploy updates them rather than adding more. */
const SWEEP_SCHEDULE_KEY = 'billing-events-sweep';
const RECONCILE_SCHEDULE_KEY = 'billing-reconciliation';

/**
 * Where the billing pipeline meets BullMQ, and the only file in this module that
 * knows a queue exists at all.
 *
 * Keeping the wiring here rather than decorating the services means the
 * processor, the sweeper and the reconciliation are plain classes a unit test
 * can call directly — no queue, no Redis, no framework — which is what makes the
 * out-of-order and stuck-event cases testable at all. It mirrors
 * `WebhookQueueRunner` deliberately.
 *
 * Registration happens on application bootstrap rather than in a constructor so
 * a worker never starts before the providers it dispatches into are resolved.
 */
@Injectable()
export class BillingQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingQueueRunner.name);

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly processor: BillingEventProcessor,
    private readonly sweeper: BillingSweeperService,
    private readonly reconciliation: BillingReconciliationService,
    private readonly seats: SeatSyncService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const started = this.queue.registerWorker<ProcessBillingEventJob & SyncBillingSeatsJob>({
      queue: BILLING_QUEUE,
      handlers: {
        [PROCESS_BILLING_EVENT_JOB]: async (job) =>
          await this.processor.process(job.data.webhookEventId),
        [SWEEP_BILLING_EVENTS_JOB]: async () => {
          await this.sweeper.sweep();
        },
        [RECONCILE_BILLING_JOB]: async () => {
          await this.reconciliation.reconcile();
        },
        [SYNC_BILLING_SEATS_JOB]: async (job) =>
          await this.seats.push(job.data.tenantId, { allowDecrease: job.data.allowDecrease }),
      },
    });

    if (!started) {
      // Said once, loudly, at boot. Billing webhooks are still accepted and
      // stored — nothing is lost — but no subscription will change state until a
      // process with Redis picks them up, and a tenant that has paid will not
      // see its plan take effect.
      this.logger.warn(
        'No billing worker started: webhooks will be stored but not applied, and no ' +
          'subscription will activate, until REDIS_URL is set.',
      );

      return;
    }

    await this.queue.schedule(
      BILLING_QUEUE,
      SWEEP_BILLING_EVENTS_JOB,
      { tenantId: null },
      {
        key: SWEEP_SCHEDULE_KEY,
        // The same interval the WhatsApp sweep runs on: both exist to turn a
        // Redis outage into lateness, and one of them being slower would make
        // the recovery window depend on which provider was affected.
        everyMs: this.config.getOrThrow<number>('WEBHOOK_SWEEP_INTERVAL_MS'),
      },
    );

    await this.queue.schedule(
      BILLING_QUEUE,
      RECONCILE_BILLING_JOB,
      { tenantId: null },
      {
        key: RECONCILE_SCHEDULE_KEY,
        everyMs: this.config.getOrThrow<number>('BILLING_RECONCILE_INTERVAL_MS'),
      },
    );
  }
}
