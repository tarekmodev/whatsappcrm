import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NOTIFY_TENANT_LIFECYCLE_JOB,
  PURGE_TENANT_JOB,
  SWEEP_TENANT_DOMAINS_JOB,
  SWEEP_TENANT_LIFECYCLE_JOB,
  TENANCY_QUEUE,
} from '../../queue/queue.constants';
import { QueueService, type TenantJobData } from '../../queue/queue.service';
import { TenantLifecycleNotifier } from '../lifecycle/tenant-lifecycle.notifier';
import { TenantLifecycleSweeper } from '../lifecycle/tenant-lifecycle.sweeper';
import { TenantPurgeService } from '../lifecycle/tenant-purge.service';
import { DomainVerificationSweeper } from './domain-verification.sweeper';

/** Stable ids for the repeatable sweeps, so a redeploy updates them rather than adding one. */
const DOMAIN_SWEEP_SCHEDULE_KEY = 'tenant-domain-verification-sweep';
const LIFECYCLE_SWEEP_SCHEDULE_KEY = 'tenant-lifecycle-sweep';

/**
 * A purge is batched, resumable and can run for minutes on a large tenant. One
 * at a time is deliberate — 0009's "breaking point" section names the serial
 * purge as the first thing to give, and the stated remedy is a dedicated
 * `lifecycle-purge` queue with its own concurrency, which is a configuration
 * change rather than a redesign precisely because the purge is already batched.
 *
 * Two, so a running purge cannot starve the five-minute lifecycle sweep behind
 * it: a tenant that never gets its timer checked because somebody else's purge
 * is halfway through a million messages is the failure this number exists to
 * prevent.
 */
const TENANCY_WORKER_CONCURRENCY = 2;

/**
 * What the payload of a lifecycle notification job carries.
 *
 * `TenantJobData`'s `tenantId` is what re-establishes tenant scope in the
 * worker; `eventId` is the row to send for, and it is also the job id, which is
 * what makes a redelivery a duplicate BullMQ discards.
 */
interface LifecycleNotificationJob extends TenantJobData {
  readonly eventId: string;
}

/**
 * Where tenancy's background work meets BullMQ, and the only file in this module
 * that knows a queue exists.
 *
 * The same split `WebhookQueueRunner` makes, for the same reason: the sweepers
 * and the purge stay plain classes a unit test can call directly — no queue, no
 * Redis, no framework — which is what makes their branches testable at all.
 *
 * Registration happens on application bootstrap rather than in a constructor, so
 * a worker never starts before the providers it dispatches into are resolved.
 *
 * ## One worker, four jobs
 *
 * Custom-domain verification and the tenant lifecycle share this queue rather
 * than taking one each. They are the same bounded context, they run at the same
 * human-scale cadence, and a second queue would be a second set of blocking
 * Redis connections per replica to serve work that is idle almost all the time.
 */
@Injectable()
export class TenancyQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenancyQueueRunner.name);

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly domains: DomainVerificationSweeper,
    private readonly lifecycle: TenantLifecycleSweeper,
    private readonly notifier: TenantLifecycleNotifier,
    private readonly purge: TenantPurgeService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const started = this.queue.registerWorker<LifecycleNotificationJob>({
      queue: TENANCY_QUEUE,
      concurrency: TENANCY_WORKER_CONCURRENCY,
      handlers: {
        [SWEEP_TENANT_DOMAINS_JOB]: async () => {
          await this.domains.sweep();
        },
        [SWEEP_TENANT_LIFECYCLE_JOB]: async () => {
          await this.lifecycle.sweep();
        },
        [NOTIFY_TENANT_LIFECYCLE_JOB]: async (job) => {
          await this.notifier.notify(job.data.eventId);
        },
        [PURGE_TENANT_JOB]: async (job) => {
          const { tenantId } = job.data;

          if (tenantId === null) {
            // Unreachable: the sweep names a tenant on every purge it queues.
            // Said out loud rather than defaulting to something, because the
            // something a purge could default to is another tenant's data.
            throw new Error('A purge job arrived with no tenant id.');
          }

          await this.purge.purge(tenantId);
        },
      },
    });

    if (!started) {
      // Said once, loudly, at boot. Both halves degrade, and they degrade
      // differently: verification still happens on demand, whereas the lifecycle
      // has no on-demand equivalent at all — nothing else moves a tenant when a
      // timer elapses.
      this.logger.warn(
        'No tenancy queue worker started: custom domains will only verify when a tenant asks, ' +
          'lapsed claims will not be released, and — more seriously — no trial will expire, no ' +
          'grace period will end and no tenant will be purged, until REDIS_URL is set.',
      );

      return;
    }

    await this.queue.schedule(
      TENANCY_QUEUE,
      SWEEP_TENANT_DOMAINS_JOB,
      { tenantId: null, eventId: '' },
      {
        key: DOMAIN_SWEEP_SCHEDULE_KEY,
        everyMs: this.config.getOrThrow<number>('DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS'),
      },
    );

    await this.queue.schedule(
      TENANCY_QUEUE,
      SWEEP_TENANT_LIFECYCLE_JOB,
      { tenantId: null, eventId: '' },
      {
        key: LIFECYCLE_SWEEP_SCHEDULE_KEY,
        everyMs: this.config.getOrThrow<number>('LIFECYCLE_SWEEP_INTERVAL_MS'),
      },
    );
  }
}
