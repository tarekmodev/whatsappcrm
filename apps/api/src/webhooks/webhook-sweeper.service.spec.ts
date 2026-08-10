import type { ConfigService } from '@nestjs/config';
import { PROCESS_WEBHOOK_EVENT_JOB, WEBHOOKS_QUEUE } from '../queue/queue.constants';
import type { QueueService } from '../queue/queue.service';
import type { WebhookEventsRepository } from './webhook-events.repository';
import { WebhookSweeperService } from './webhook-sweeper.service';

const STUCK_AFTER_MS = 60_000;
const MAX_ATTEMPTS = 5;
const NOW = new Date('2026-08-10T12:00:00.000Z');

describe('WebhookSweeperService', () => {
  let findStale: jest.Mock;
  let enqueue: jest.Mock;
  let sweeper: WebhookSweeperService;

  beforeEach(() => {
    findStale = jest.fn().mockResolvedValue([]);
    enqueue = jest.fn().mockResolvedValue('added');

    sweeper = new WebhookSweeperService(
      {
        getOrThrow: (key: string) =>
          key === 'WEBHOOK_STUCK_AFTER_MS' ? STUCK_AFTER_MS : MAX_ATTEMPTS,
      } as unknown as ConfigService,
      { findStale } as unknown as WebhookEventsRepository,
      { enqueue } as unknown as QueueService,
    );
  });

  it('looks for events that have been stuck for longer than the threshold', async () => {
    await sweeper.sweep(NOW);

    expect(findStale).toHaveBeenCalledWith(new Date(NOW.getTime() - STUCK_AFTER_MS), 200);
  });

  /**
   * The property that turns a Redis outage into lateness rather than loss: a row
   * that was stored but never enqueued is put back on the queue by its durable
   * row id.
   */
  it('re-enqueues each stuck event by its stored row id', async () => {
    findStale.mockResolvedValue(['event-1', 'event-2']);

    await expect(sweeper.sweep(NOW)).resolves.toBe(2);

    expect(enqueue).toHaveBeenCalledWith(
      WEBHOOKS_QUEUE,
      PROCESS_WEBHOOK_EVENT_JOB,
      { tenantId: null, webhookEventId: 'event-1' },
      expect.objectContaining({ attempts: MAX_ATTEMPTS }),
    );
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  /**
   * The id the ingest path uses may still be held by a job `removeOnFail`
   * retained — and BullMQ ignores an `add` for an id it holds, in the failed set
   * as much as the waiting one. Re-adding under that id is the silent no-op this
   * sweep exists to avoid: it would report recovery it never performed, forever,
   * for exactly the row whose terminal write failed.
   */
  it('re-enqueues under an id no retained corpse can be holding', async () => {
    findStale.mockResolvedValue(['event-1']);

    await sweeper.sweep(NOW);

    const [, , , options] = enqueue.mock.calls[0] as [string, string, unknown, { jobId: string }];

    expect(options.jobId).toBe(`webhook-event-event-1-sweep-${NOW.getTime()}`);
    expect(options.jobId).not.toBe('webhook-event-event-1');
  });

  /**
   * The sweep is the one caller that acts on the difference — its count is a
   * recovery report — so it is the one that pays for the extra read.
   */
  it('asks the queue to tell an add apart from a duplicate', async () => {
    findStale.mockResolvedValue(['event-1']);

    await sweeper.sweep(NOW);

    expect(enqueue).toHaveBeenCalledWith(
      WEBHOOKS_QUEUE,
      PROCESS_WEBHOOK_EVENT_JOB,
      expect.anything(),
      expect.objectContaining({ detectDuplicate: true }),
    );
  });

  it('gives two events in one sweep two different job ids', async () => {
    findStale.mockResolvedValue(['event-1', 'event-2']);

    await sweeper.sweep(NOW);

    const calls = enqueue.mock.calls as [string, string, unknown, { jobId: string }][];
    const ids = calls.map(([, , , options]) => options.jobId);

    expect(new Set(ids).size).toBe(2);
  });

  it('does nothing when nothing is stuck', async () => {
    await expect(sweeper.sweep(NOW)).resolves.toBe(0);

    expect(enqueue).not.toHaveBeenCalled();
  });

  /** The sweep is itself best-effort: a queue that is still down is swept again next interval. */
  it('reports only what actually reached the queue', async () => {
    findStale.mockResolvedValue(['event-1', 'event-2']);
    enqueue.mockResolvedValueOnce('added').mockResolvedValueOnce('failed');

    await expect(sweeper.sweep(NOW)).resolves.toBe(1);
  });

  /**
   * A job that was ignored as a duplicate was not queued, and counting it as
   * recovery is how a sweep comes to log `Re-enqueued 1 of 1` while doing
   * nothing at all.
   */
  it('does not count a duplicate as re-enqueued', async () => {
    findStale.mockResolvedValue(['event-1']);
    enqueue.mockResolvedValue('duplicate');

    await expect(sweeper.sweep(NOW)).resolves.toBe(0);
  });
});
