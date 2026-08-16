import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SWEEP_TENANT_DOMAINS_JOB, TENANCY_QUEUE } from '../../queue/queue.constants';
import { QueueService, type TenantJobData } from '../../queue/queue.service';
import { DomainVerificationSweeper } from './domain-verification.sweeper';

/** Stable id for the repeatable sweep, so a redeploy updates it rather than adding one. */
const SWEEP_SCHEDULE_KEY = 'tenant-domain-verification-sweep';

/**
 * Where tenancy's background work meets BullMQ, and the only file in this module
 * that knows a queue exists.
 *
 * The same split `WebhookQueueRunner` makes, for the same reason: the sweeper
 * stays a plain class a unit test can call directly — no queue, no Redis, no
 * framework — which is what makes the backoff and expiry cases testable at all.
 *
 * Registration happens on application bootstrap rather than in a constructor, so
 * a worker never starts before the providers it dispatches into are resolved.
 */
@Injectable()
export class TenancyQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenancyQueueRunner.name);

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly sweeper: DomainVerificationSweeper,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const started = this.queue.registerWorker<TenantJobData>({
      queue: TENANCY_QUEUE,
      handlers: {
        [SWEEP_TENANT_DOMAINS_JOB]: async () => {
          await this.sweeper.sweep();
        },
      },
    });

    if (!started) {
      // Said once, loudly, at boot. Claims can still be made and verified on
      // demand — the tenant-facing verify button does not need a queue — but
      // nothing will verify in the background and no lapsed claim will be
      // released, so a squatted hostname stays held indefinitely.
      this.logger.warn(
        'No tenancy queue worker started: custom domains will only verify when a tenant asks, ' +
          'and lapsed claims will not be released, until REDIS_URL is set.',
      );

      return;
    }

    await this.queue.schedule(
      TENANCY_QUEUE,
      SWEEP_TENANT_DOMAINS_JOB,
      { tenantId: null },
      {
        key: SWEEP_SCHEDULE_KEY,
        everyMs: this.config.getOrThrow<number>('DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS'),
      },
    );
  }
}
