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
    enqueue = jest.fn().mockResolvedValue(true);

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
   * id, under the same job id, so a duplicate collapses.
   */
  it('re-enqueues each stuck event by its stored row id', async () => {
    findStale.mockResolvedValue(['event-1', 'event-2']);

    await expect(sweeper.sweep(NOW)).resolves.toBe(2);

    expect(enqueue).toHaveBeenCalledWith(
      WEBHOOKS_QUEUE,
      PROCESS_WEBHOOK_EVENT_JOB,
      { tenantId: null, webhookEventId: 'event-1' },
      expect.objectContaining({ jobId: 'webhook-event-event-1', attempts: MAX_ATTEMPTS }),
    );
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('does nothing when nothing is stuck', async () => {
    await expect(sweeper.sweep(NOW)).resolves.toBe(0);

    expect(enqueue).not.toHaveBeenCalled();
  });

  /** The sweep is itself best-effort: a queue that is still down is swept again next interval. */
  it('reports only what actually reached the queue', async () => {
    findStale.mockResolvedValue(['event-1', 'event-2']);
    enqueue.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(sweeper.sweep(NOW)).resolves.toBe(1);
  });
});
