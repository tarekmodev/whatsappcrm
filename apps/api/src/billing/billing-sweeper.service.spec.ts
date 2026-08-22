import type { ConfigService } from '@nestjs/config';
import type { QueueService } from '../queue/queue.service';
import type { WebhookEventsRepository } from '../webhooks/webhook-events.repository';
import { BillingSweeperService } from './billing-sweeper.service';

const STUCK_AFTER_MS = 60_000;
const MAX_ATTEMPTS = 5;
const NOW = new Date('2026-08-22T09:00:00.000Z');

describe('BillingSweeperService', () => {
  let findStale: jest.Mock;
  let enqueue: jest.Mock;
  let sweeper: BillingSweeperService;

  beforeEach(() => {
    findStale = jest.fn().mockResolvedValue([]);
    enqueue = jest.fn().mockResolvedValue('added');

    sweeper = new BillingSweeperService(
      {
        getOrThrow: (key: string) =>
          key === 'WEBHOOK_STUCK_AFTER_MS' ? STUCK_AFTER_MS : MAX_ATTEMPTS,
      } as unknown as ConfigService,
      { findStale } as unknown as WebhookEventsRepository,
      { enqueue } as unknown as QueueService,
    );
  });

  /**
   * The reason this sweeper exists separately at all: each provider has its own
   * worker on its own queue, and a BullMQ worker fails loudly on a job name its
   * handler map does not carry. An unfiltered sweep would hand a billing payload
   * to `WhatsAppEventProcessor`, which would park every one of them.
   */
  it('reclaims only billing rows, never the WhatsApp ones', async () => {
    await sweeper.sweep(NOW);

    expect(findStale).toHaveBeenCalledWith(
      'billing',
      new Date(NOW.getTime() - STUCK_AFTER_MS),
      200,
    );
  });

  /**
   * What turns a Redis outage into billing events arriving late rather than not
   * at all: a row that was stored but never enqueued goes back on the queue by
   * its durable row id.
   */
  it('re-enqueues each stuck event onto the billing queue', async () => {
    findStale.mockResolvedValue(['event-1', 'event-2']);

    await expect(sweeper.sweep(NOW)).resolves.toBe(2);

    expect(enqueue).toHaveBeenCalledWith(
      'billing',
      'billing.process-event',
      { tenantId: null, webhookEventId: 'event-1' },
      expect.objectContaining({ attempts: MAX_ATTEMPTS, detectDuplicate: true }),
    );
  });

  /**
   * `removeOnFail` retains a failed job under the ingest path's deterministic id
   * for a long time, and BullMQ ignores an `add` for an id it still holds — so
   * the sweep has to use an id of its own or every sweep is a silent no-op for
   * exactly the row it exists to recover.
   */
  it('re-enqueues under an id the ingest path cannot already be holding', async () => {
    findStale.mockResolvedValue(['event-1']);

    await sweeper.sweep(NOW);

    const options = (enqueue.mock.calls[0] as unknown[])[3] as { jobId: string };

    expect(options.jobId).toBe(`billing-event-event-1-sweep-${NOW.getTime()}`);
  });

  /**
   * The count is a recovery report, so it counts jobs actually created rather
   * than calls made — a duplicate counted as a re-enqueue is the log line lying
   * about how much of a backlog was recovered.
   */
  it('reports only the jobs it actually created', async () => {
    findStale.mockResolvedValue(['event-1', 'event-2']);
    enqueue.mockResolvedValueOnce('added').mockResolvedValueOnce('duplicate');

    await expect(sweeper.sweep(NOW)).resolves.toBe(1);
  });

  it('does nothing, and says nothing, when there is nothing stuck', async () => {
    await expect(sweeper.sweep(NOW)).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
