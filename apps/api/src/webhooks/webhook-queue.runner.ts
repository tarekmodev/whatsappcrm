import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PROCESS_WEBHOOK_EVENT_JOB,
  SWEEP_WEBHOOK_EVENTS_JOB,
  WEBHOOKS_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import type { ProcessWebhookEventJob } from './webhook-jobs';
import { WebhookSweeperService } from './webhook-sweeper.service';
import { WhatsAppEventProcessor } from './whatsapp-event.processor';

/** Stable id for the repeatable sweep, so a redeploy updates it rather than adding one. */
const SWEEP_SCHEDULE_KEY = 'webhook-events-sweep';

/**
 * Where the webhook pipeline meets BullMQ, and the only file in this module that
 * knows a queue exists at all.
 *
 * Keeping the wiring here rather than decorating the services means the
 * processor and the sweeper are plain classes a unit test can call directly —
 * no queue, no Redis, no framework — which is what makes the out-of-order and
 * stuck-event cases testable at all.
 *
 * Registration happens on application bootstrap rather than in a constructor so
 * that a worker never starts before the providers it dispatches into are
 * resolved.
 */
@Injectable()
export class WebhookQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebhookQueueRunner.name);

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly processor: WhatsAppEventProcessor,
    private readonly sweeper: WebhookSweeperService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const started = this.queue.registerWorker<ProcessWebhookEventJob>({
      queue: WEBHOOKS_QUEUE,
      handlers: {
        [PROCESS_WEBHOOK_EVENT_JOB]: async (job) =>
          await this.processor.process(job.data.webhookEventId),
        [SWEEP_WEBHOOK_EVENTS_JOB]: async () => {
          await this.sweeper.sweep();
        },
      },
    });

    if (!started) {
      // Said once, loudly, at boot. Inbound webhooks are still accepted and
      // stored — nothing is lost — but nothing will move them into the inbox
      // until a process with Redis picks them up.
      this.logger.warn(
        'No queue worker started: inbound webhooks will be stored but not processed until REDIS_URL is set.',
      );
      return;
    }

    await this.queue.schedule(
      WEBHOOKS_QUEUE,
      SWEEP_WEBHOOK_EVENTS_JOB,
      { tenantId: null },
      {
        key: SWEEP_SCHEDULE_KEY,
        everyMs: this.config.getOrThrow<number>('WEBHOOK_SWEEP_INTERVAL_MS'),
      },
    );
  }
}
