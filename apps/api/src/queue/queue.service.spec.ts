import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { QueueService, type TenantJobData } from './queue.service';

function build(redisUrl?: string): { queue: QueueService; tenantContext: TenantContextService } {
  const tenantContext = new TenantContextService();
  const config = { get: () => redisUrl } as unknown as ConfigService;

  return { queue: new QueueService(config, tenantContext), tenantContext };
}

describe('QueueService with no Redis configured', () => {
  it('reports itself disabled rather than throwing at construction', () => {
    expect(build().queue.isEnabled).toBe(false);
  });

  it('reports itself enabled once a URL is configured', () => {
    expect(build('redis://localhost:6379').queue.isEnabled).toBe(true);
  });

  /**
   * The degraded state the whole ingest design tolerates: work is already
   * durable in Postgres before anything is enqueued, so a missing queue is
   * lateness and must never become a failed request.
   */
  it('reports a failed enqueue instead of throwing', async () => {
    await expect(build().queue.enqueue('q', 'job', { tenantId: null })).resolves.toBe(false);
  });

  it('reports a failed schedule instead of throwing', async () => {
    await expect(
      build().queue.schedule('q', 'job', { tenantId: null }, { key: 'k', everyMs: 1_000 }),
    ).resolves.toBe(false);
  });

  it('starts no worker, and says so to its caller', () => {
    expect(build().queue.registerWorker({ queue: 'q', handlers: {} })).toBe(false);
  });

  it('shuts down cleanly with nothing to close', async () => {
    await expect(build().queue.onApplicationShutdown()).resolves.toBeUndefined();
  });
});

describe('QueueService with Redis configured but unreachable', () => {
  /**
   * The property that keeps a Redis outage from becoming a webhook outage. An
   * enqueue against a Redis that is not answering must *fail*, not wait: ioredis
   * would otherwise park the command in its offline queue, the ingest route
   * would hang, and Meta would time out and retry the delivery it had already
   * stored. Jest's own 5s timeout is the assertion — a hang fails this test.
   *
   * Running this file **on its own** prints "Jest did not exit one second after
   * the test run": ioredis leaves its command-timeout timer armed when the
   * command rejects for another reason, so the loop stays busy for the length of
   * that timeout and no longer. It is a delayed exit, not a leaked handle, and
   * the full suite has other work in flight so it never surfaces there.
   */
  it('gives up on an enqueue rather than hanging the caller', async () => {
    const { queue } = build('redis://127.0.0.1:6399');

    await expect(queue.enqueue('q', 'job', { tenantId: null })).resolves.toBe(false);

    await queue.onApplicationShutdown();
  });
});

/**
 * The dispatcher is exercised directly rather than through Redis: what matters
 * is that a job runs inside a tenant context scope, which is what `TenantPrisma`
 * reads and therefore what stops a worker either failing closed or — far worse —
 * inheriting the previous job's tenant.
 */
describe('the job dispatcher', () => {
  interface TestJobData extends TenantJobData {
    readonly marker?: string;
  }

  function dispatch(
    service: QueueService,
    handlers: Record<string, (job: Job<TestJobData>) => Promise<void>>,
    job: Partial<Job<TestJobData>>,
  ): Promise<void> {
    // `runInTenantScope` is private because nothing but the worker should call
    // it; reaching it here is deliberate, and narrower than standing up Redis.
    return (
      service as unknown as {
        runInTenantScope: (
          job: Job<TestJobData>,
          handlers: Record<string, (job: Job<TestJobData>) => Promise<void>>,
        ) => Promise<void>;
      }
    ).runInTenantScope(
      {
        name: 'job',
        id: '1',
        queueName: 'q',
        data: { tenantId: null },
        ...job,
      } as Job<TestJobData>,
      handlers,
    );
  }

  it('runs the handler inside a scope carrying the job’s tenant', async () => {
    const { queue, tenantContext } = build('redis://localhost:6379');
    let observed: string | null = 'unset';

    await dispatch(
      queue,
      {
        job: () => {
          observed = tenantContext.tenantId;
          return Promise.resolve();
        },
      },
      { data: { tenantId: 'tenant-a' } },
    );

    expect(observed).toBe('tenant-a');
    expect(tenantContext.tenantId).toBeNull();
  });

  it('correlates the job’s logs with its id', async () => {
    const { queue, tenantContext } = build('redis://localhost:6379');
    let requestId: string | null = null;

    await dispatch(
      queue,
      {
        job: () => {
          requestId = tenantContext.requestId;
          return Promise.resolve();
        },
      },
      { id: '42' },
    );

    expect(requestId).toBe('job:job:42');
  });

  /** A deploy that removed a processor while jobs were queued: retry, do not swallow. */
  it('throws for a job name nothing handles', async () => {
    const { queue } = build('redis://localhost:6379');

    await expect(dispatch(queue, {}, { name: 'gone' })).rejects.toThrow('No handler registered');
  });
});
