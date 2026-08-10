import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type ConnectionOptions, type Job, type JobsOptions } from 'bullmq';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { QUEUE_KEY_PREFIX } from './queue.constants';

/**
 * Every job payload carries the tenant it is for. A queue is process-wide and
 * shared by every tenant, so a job that did not name one would be indexed,
 * cached and written under whatever tenant happened to be in scope when the
 * worker picked it up — which is the shape a cross-tenant leak takes in a
 * background job (TAR-39, multi-tenancy rule 6).
 *
 * `null` is legal and means "not resolved yet": the webhook processor learns its
 * tenant by looking up `phone_number_id`, which is the whole point of storing
 * the payload before routing it.
 */
export interface TenantJobData {
  readonly tenantId: string | null;
}

/**
 * What an `enqueue` did. Four outcomes rather than a boolean, because "the job
 * is queued" and "something with that id was already there" are different facts
 * and only one of them means work was scheduled.
 *
 *   * `added`       — queued, and a worker will pick it up.
 *   * `duplicate`   — an id already held, in any state. Nothing was queued.
 *   * `unavailable` — no Redis configured. Expected in a bare clone.
 *   * `failed`      — Redis refused or timed out. The caller's row is durable;
 *                     the sweeper is the backstop.
 */
export type EnqueueOutcome = 'added' | 'duplicate' | 'unavailable' | 'failed';

export type JobHandler<TData extends TenantJobData> = (job: Job<TData>) => Promise<void>;

/** Job name → handler. A job whose name is not in the map fails loudly. */
export type JobHandlers<TData extends TenantJobData> = Readonly<Record<string, JobHandler<TData>>>;

export interface WorkerRegistration<TData extends TenantJobData> {
  readonly queue: string;
  readonly handlers: JobHandlers<TData>;
  /** Jobs processed in parallel by this worker. Defaults to 1 — raise on evidence. */
  readonly concurrency?: number;
}

export interface ScheduleOptions {
  /** Stable id for the schedule, so a redeploy updates it rather than adding a second one. */
  readonly key: string;
  readonly everyMs: number;
}

/**
 * Cap on how long a *producer* command may wait for Redis.
 *
 * Without it a Redis outage does not fail an enqueue — it parks the command in
 * ioredis's offline queue and waits, which would turn "the queue is down" into
 * "the webhook route hangs", and a hung webhook is one Meta times out and
 * retries. Bounding it here is what makes the degraded path actually degrade:
 * the enqueue reports failure, the row stays durable, and the sweeper collects
 * it.
 *
 * Generous enough to cover a cold connection on a healthy Redis — the first
 * enqueue after boot pays the connect — and far short of Meta's own timeout.
 */
const PRODUCER_COMMAND_TIMEOUT_MS = 2_000;

/**
 * BullMQ registration and tenant-context propagation into workers — the surface
 * TAR-39's module table assigns to `QueueModule`.
 *
 * Three decisions worth knowing:
 *
 *   * **Enqueueing never fails a caller.** `enqueue` reports a boolean and logs;
 *     it does not throw. ADR 0001 put both realtime and the queue on Redis, and
 *     the durability rule that follows from it is that a caller has already
 *     committed its work to Postgres before it enqueues. Turning a Redis blip
 *     into a 500 would undo exactly the property that design bought — the
 *     sweeper re-enqueues what nothing picked up.
 *   * **Every job runs inside a tenant context scope**, opened here rather than
 *     remembered by each processor. `AsyncLocalStorage` is what `TenantPrisma`
 *     reads, and a worker that forgot to open one would either fail closed on
 *     every query or, worse, inherit a scope from the job before it.
 *   * **No Redis configured is a supported state.** The API boots, HTTP serves,
 *     and anything queued stays durably in Postgres until a worker exists. This
 *     is what lets `pnpm test` and a bare clone run with no containers up.
 *
 * TAR-41 owns this module and is expected to extend it — metrics, dead-letter
 * handling, a shared connection with the session store — rather than replace it.
 */
@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly redisUrl: string | null;
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Set<Worker>();

  constructor(
    config: ConfigService,
    private readonly tenantContext: TenantContextService,
  ) {
    const url = config.get<string>('REDIS_URL');

    this.redisUrl = url === undefined || url.length === 0 ? null : url;

    if (this.redisUrl === null) {
      this.logger.warn(
        'REDIS_URL is not set: queues are disabled. Work is still stored durably, but nothing will process it.',
      );
    }
  }

  /** False when no Redis is configured. Callers degrade rather than fail. */
  get isEnabled(): boolean {
    return this.redisUrl !== null;
  }

  /**
   * Adds a job. Reports what happened, and never throws.
   *
   * `jobId` in `options` is the deduplication handle: BullMQ ignores an `add`
   * whose id it already holds, which collapses a Meta retry and a re-enqueue of
   * the same row into one job. It is an optimisation, not the correctness
   * mechanism — handlers stay idempotent regardless.
   *
   * **`duplicate` is a distinct outcome from `added`, and the distinction is
   * load-bearing.** BullMQ's `add` does not throw or otherwise signal that it
   * ignored the call, so a caller that treated any non-throwing `add` as work
   * queued would report success for a job that will never run — and `add`
   * ignores an id held in the *failed* set too, which `removeOnFail` retains
   * long after the job stopped being alive. A sweeper counting those as
   * re-enqueued reports recovery it did not perform.
   *
   * The check is a read before the write, so two producers racing on the same id
   * can both be told `added`. That costs a log line, not correctness: BullMQ
   * still keeps exactly one job, and the handler is idempotent either way.
   */
  async enqueue<TData extends TenantJobData>(
    queueName: string,
    jobName: string,
    data: TData,
    options?: JobsOptions,
  ): Promise<EnqueueOutcome> {
    const queue = this.queue(queueName);

    if (queue === null) {
      return 'unavailable';
    }

    try {
      if (options?.jobId !== undefined && (await queue.getJob(options.jobId)) !== undefined) {
        return 'duplicate';
      }

      await queue.add(jobName, data, options);
      return 'added';
    } catch (error: unknown) {
      this.logger.error(
        `Could not enqueue ${jobName} on ${queueName}; the sweeper will retry: ${describe(error)}`,
      );
      return 'failed';
    }
  }

  /**
   * Installs — or updates — a repeatable job. Idempotent on `key`, so a rolling
   * deploy replaces the schedule instead of accumulating one per replica.
   */
  async schedule<TData extends TenantJobData>(
    queueName: string,
    jobName: string,
    data: TData,
    { key, everyMs }: ScheduleOptions,
  ): Promise<boolean> {
    const queue = this.queue(queueName);

    if (queue === null) {
      return false;
    }

    try {
      await queue.upsertJobScheduler(key, { every: everyMs }, { name: jobName, data });
      return true;
    } catch (error: unknown) {
      this.logger.error(`Could not schedule ${jobName} on ${queueName}: ${describe(error)}`);
      return false;
    }
  }

  /**
   * Starts a worker for `queue`, dispatching by job name.
   *
   * Returns whether a worker was started, so a caller can log the degraded state
   * once at boot rather than discovering it per job.
   */
  registerWorker<TData extends TenantJobData>({
    queue,
    handlers,
    concurrency = 1,
  }: WorkerRegistration<TData>): boolean {
    const connection = this.connectionFor('worker');

    if (connection === null) {
      return false;
    }

    const worker = new Worker<TData>(
      queue,
      async (job) => await this.runInTenantScope(job, handlers),
      { connection, prefix: QUEUE_KEY_PREFIX, concurrency },
    );

    // BullMQ emits `error` for connection trouble. Without a listener Node
    // treats it as an unhandled `error` event and takes the process down, which
    // would turn a Redis restart into an API outage.
    worker.on('error', (error) => {
      this.logger.warn(`Worker on ${queue} reported: ${describe(error)}`);
    });

    worker.on('failed', (job, error) => {
      this.logger.warn(`Job ${job?.name ?? 'unknown'} on ${queue} failed: ${describe(error)}`);
    });

    this.workers.add(worker);

    return true;
  }

  /**
   * Closes every worker before every queue: a worker closed second could pick up
   * one more job from a connection that is already going away, and BullMQ would
   * then stall that job until its lock expires.
   *
   * Each `close()` is followed by `disconnect()`. `close()` drains gracefully,
   * which is the behaviour a rolling deploy wants — but a connection that is
   * still retrying an unreachable Redis has nothing to drain and leaves its
   * reconnect timer armed, so the process would sit past its termination grace
   * period during the one incident where a clean exit matters most.
   * `disconnect()` tears that down; on a healthy connection it is a no-op,
   * because `close()` has already finished.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.workers].map(async (worker) => await shutDown(worker)));
    await Promise.all([...this.queues.values()].map(async (queue) => await shutDown(queue)));

    this.workers.clear();
    this.queues.clear();
  }

  /**
   * Connection options for one side of the queue.
   *
   * Producers and workers need different behaviour under an outage, which is why
   * this builds a fresh object per use rather than sharing one. A producer must
   * give up quickly so its caller can fall back; a worker must not, because its
   * blocking reads are supposed to wait.
   */
  private connectionFor(side: 'producer' | 'worker'): ConnectionOptions | null {
    if (this.redisUrl === null) {
      return null;
    }

    return {
      url: this.redisUrl,
      // BullMQ requires this for the blocking commands a worker issues: ioredis
      // would otherwise abort a `BRPOPLPUSH` that is behaving exactly as
      // intended. Harmless on a producer, where the timeout below is the bound.
      maxRetriesPerRequest: null,
      // Nothing connects until the first command, so a process that never
      // touches a queue never opens a socket.
      lazyConnect: true,
      ...(side === 'producer' ? { commandTimeout: PRODUCER_COMMAND_TIMEOUT_MS } : {}),
    };
  }

  /** One `Queue` per name for the lifetime of the process — each holds a connection. */
  private queue(name: string): Queue | null {
    const existing = this.queues.get(name);

    if (existing !== undefined) {
      return existing;
    }

    const connection = this.connectionFor('producer');

    if (connection === null) {
      return null;
    }

    const queue = new Queue(name, { connection, prefix: QUEUE_KEY_PREFIX });

    queue.on('error', (error) => {
      this.logger.warn(`Queue ${name} reported: ${describe(error)}`);
    });

    this.queues.set(name, queue);

    return queue;
  }

  private async runInTenantScope<TData extends TenantJobData>(
    job: Job<TData>,
    handlers: JobHandlers<TData>,
  ): Promise<void> {
    const handler = handlers[job.name];

    if (handler === undefined) {
      // A job name nothing handles is a deploy that removed a processor while
      // jobs were still queued. Throwing lets BullMQ retry it, so the fix is a
      // rollback rather than a hunt through Redis for what was lost.
      throw new Error(`No handler registered for job ${job.name} on queue ${job.queueName}`);
    }

    return await this.tenantContext.run(
      {
        // The job id is the correlation handle for everything this job logs,
        // exactly as the request id is for an HTTP call.
        requestId: `job:${job.name}:${job.id ?? 'unknown'}`,
        tenantId: job.data.tenantId,
        userId: null,
      },
      async () => await handler(job),
    );
  }
}

/**
 * Drains, then forcibly releases the socket. Errors are swallowed on purpose:
 * shutdown must not be the thing that fails a shutdown, and by this point the
 * process is on its way out with nothing left to report to.
 */
async function shutDown(closeable: Queue | Worker): Promise<void> {
  await closeable.close().catch(() => undefined);
  await closeable.disconnect().catch(() => undefined);
}

/** Never interpolate an unknown into a template literal — `[object Object]` helps nobody. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
