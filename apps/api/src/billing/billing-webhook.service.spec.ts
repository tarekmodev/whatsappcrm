import type { ConfigService } from '@nestjs/config';
import type { BillingProvider } from '@whatsappcrm/contracts';
import type { QueueService } from '../queue/queue.service';
import type { WebhookEventsRepository } from '../webhooks/webhook-events.repository';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingWebhookRefusedError } from './billing.errors';

const TOLERANCE_MS = 5 * 60 * 1_000;
const NOW = new Date('2026-08-22T09:00:00.000Z');

/** A body and the headers a well-formed Standard Webhooks delivery carries. */
const BODY = Buffer.from(JSON.stringify({ type: 'subscription.active', data: {} }), 'utf8');

function headers(overrides: Record<string, string | undefined> = {}) {
  return {
    'webhook-id': 'msg_1',
    'webhook-timestamp': String(Math.floor(NOW.getTime() / 1_000)),
    'webhook-signature': 'v1,whatever',
    ...overrides,
  };
}

function serviceWith(options: { verifies?: boolean; stored?: string | null; enqueue?: jest.Mock }) {
  const store = jest
    .fn()
    .mockResolvedValue(options.stored === undefined ? 'row-1' : options.stored);
  const enqueue = options.enqueue ?? jest.fn().mockResolvedValue('added');
  const verifyWebhookSignature = jest.fn().mockReturnValue(options.verifies ?? true);

  const service = new BillingWebhookService(
    {
      getOrThrow: (key: string) => (key === 'BILLING_WEBHOOK_TOLERANCE_MS' ? TOLERANCE_MS : 5),
    } as unknown as ConfigService,
    { verifyWebhookSignature } as unknown as BillingProvider,
    { store } as unknown as WebhookEventsRepository,
    { enqueue } as unknown as QueueService,
  );

  return { service, store, enqueue, verifyWebhookSignature };
}

/**
 * The ingest half: verify, store, answer, enqueue — and the order is the whole
 * design, so most of these assert what *did not* happen.
 */
describe('BillingWebhookService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('nothing is written before the signature passes', () => {
    /**
     * The one thing an anonymous caller could otherwise do to a public route
     * that is deliberately exempt from rate limiting: grow the table.
     */
    it('refuses an unsigned payload without touching the store', async () => {
      const { service, store, enqueue } = serviceWith({ verifies: false });

      await expect(service.ingest(BODY, headers())).rejects.toBeInstanceOf(
        BillingWebhookRefusedError,
      );
      expect(store).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    /**
     * The only signal that Nest's `rawBody` option went missing from bootstrap,
     * which otherwise presents as every delivery being refused and gets
     * diagnosed as a wrong secret.
     */
    it('refuses a request with no raw body', async () => {
      const { service, store } = serviceWith({});

      await expect(service.ingest(undefined, headers())).rejects.toBeInstanceOf(
        BillingWebhookRefusedError,
      );
      expect(store).not.toHaveBeenCalled();
    });
  });

  describe('the signed timestamp bounds a replay', () => {
    it('accepts a delivery inside the tolerance', async () => {
      const { service } = serviceWith({});
      const recent = String(Math.floor((NOW.getTime() - 60_000) / 1_000));

      await expect(service.ingest(BODY, headers({ 'webhook-timestamp': recent }))).resolves.toBe(
        'stored',
      );
    });

    /**
     * Without this, a captured signature stays valid forever — a delivery lifted
     * from a log or a proxy could be re-presented at any time.
     */
    it('refuses one that is too old', async () => {
      const { service, store } = serviceWith({});
      const stale = String(Math.floor((NOW.getTime() - TOLERANCE_MS - 1_000) / 1_000));

      await expect(
        service.ingest(BODY, headers({ 'webhook-timestamp': stale })),
      ).rejects.toBeInstanceOf(BillingWebhookRefusedError);
      expect(store).not.toHaveBeenCalled();
    });

    /** A timestamp in the future is as suspicious as a stale one. */
    it('refuses one that is too far ahead', async () => {
      const { service } = serviceWith({});
      const ahead = String(Math.floor((NOW.getTime() + TOLERANCE_MS + 1_000) / 1_000));

      await expect(
        service.ingest(BODY, headers({ 'webhook-timestamp': ahead })),
      ).rejects.toBeInstanceOf(BillingWebhookRefusedError);
    });

    it('refuses a missing or unparseable timestamp rather than waving it through', async () => {
      const { service } = serviceWith({});

      await expect(
        service.ingest(BODY, headers({ 'webhook-timestamp': undefined })),
      ).rejects.toBeInstanceOf(BillingWebhookRefusedError);
      await expect(
        service.ingest(BODY, headers({ 'webhook-timestamp': 'yesterday' })),
      ).rejects.toBeInstanceOf(BillingWebhookRefusedError);
    });
  });

  describe('the replay defence', () => {
    /**
     * The idempotency key is the `webhook-id` **header**, which is what Standard
     * Webhooks specifies — and it exists whether or not the provider puts an id
     * in the body.
     */
    it('stores under the provider event id from the header', async () => {
      const { service, store } = serviceWith({});

      await service.ingest(BODY, headers({ 'webhook-id': 'msg_from_header' }));

      expect(store).toHaveBeenCalledWith('billing', 'msg_from_header', expect.anything());
    });

    /**
     * `provider = 'billing'`, not `'polar'`: the published `WEBHOOK_PROVIDERS`
     * enum carries the former, and a provider name written by a service outside
     * `providers/polar/` is exactly the leak the port exists to prevent.
     */
    it('records the provider as `billing`, keeping the vendor name out of the table', async () => {
      const { service, store } = serviceWith({});

      await service.ingest(BODY, headers());

      expect(store).toHaveBeenCalledWith('billing', expect.anything(), expect.anything());
    });

    /**
     * Zero rows inserted **is** the duplicate signal — no read-then-write race
     * between two concurrent deliveries of the same event.
     */
    it('absorbs a redelivery and queues nothing a second time', async () => {
      const { service, enqueue } = serviceWith({ stored: null });

      await expect(service.ingest(BODY, headers())).resolves.toBe('duplicate');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('refuses a delivery with no id to key idempotency on', async () => {
      const { service, store } = serviceWith({});

      await expect(
        service.ingest(BODY, headers({ 'webhook-id': undefined })),
      ).rejects.toBeInstanceOf(BillingWebhookRefusedError);
      expect(store).not.toHaveBeenCalled();
    });
  });

  describe('what is stored', () => {
    /**
     * Re-parsed from the raw bytes rather than taken from Express's parsed body,
     * so what is stored is provably what was signed.
     */
    it('stores the payload the signature covered', async () => {
      const { service, store } = serviceWith({});

      await service.ingest(BODY, headers());

      expect(store).toHaveBeenCalledWith('billing', 'msg_1', {
        type: 'subscription.active',
        data: {},
      });
    });
  });

  describe('a queue that is down is lateness, not loss', () => {
    /**
     * The row is durable and the sweeper re-enqueues it. Failing the request
     * would make the provider retry a delivery we already hold — and ten
     * consecutive non-2xx responses disable the endpoint.
     */
    it('still reports the delivery as stored when the enqueue fails', async () => {
      const { service } = serviceWith({ enqueue: jest.fn().mockResolvedValue('failed') });

      await expect(service.ingest(BODY, headers())).resolves.toBe('stored');
    });
  });
});
