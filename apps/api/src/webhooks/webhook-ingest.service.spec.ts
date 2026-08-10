import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { PROCESS_WEBHOOK_EVENT_JOB, WEBHOOKS_QUEUE } from '../queue/queue.constants';
import type { QueueService } from '../queue/queue.service';
import type { WebhookEventsRepository } from './webhook-events.repository';
import { WebhookIngestService } from './webhook-ingest.service';
import { WebhookChannelNotConfiguredError, WebhookSignatureInvalidError } from './webhook.errors';

const APP_SECRET = 'meta-app-secret';
const VERIFY_TOKEN = 'the-verify-token';

const ENV: Record<string, unknown> = {
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  WEBHOOK_MAX_ATTEMPTS: 5,
};

const RAW_BODY = Buffer.from(
  JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-1', changes: [] }] }),
  'utf8',
);

function sign(body: Buffer): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

describe('WebhookIngestService', () => {
  let store: jest.Mock;
  let enqueue: jest.Mock;
  let service: WebhookIngestService;

  /** `(provider, providerEventId, payload)`, typed so the assertions below are checked. */
  function storeCall(index: number): [string, string, unknown] {
    return store.mock.calls[index] as [string, string, unknown];
  }

  function build(env: Record<string, unknown> = ENV): WebhookIngestService {
    store = jest.fn().mockResolvedValue('event-1');
    enqueue = jest.fn().mockResolvedValue(true);

    const config = {
      get: (key: string) => env[key],
      getOrThrow: (key: string) => env[key],
    } as unknown as ConfigService;

    return new WebhookIngestService(
      config,
      { store } as unknown as WebhookEventsRepository,
      { enqueue } as unknown as QueueService,
    );
  }

  beforeEach(() => {
    service = build();
  });

  describe('the verification handshake', () => {
    it('echoes the challenge when the token matches', () => {
      expect(service.verifyHandshake(VERIFY_TOKEN, 'challenge-123')).toBe('challenge-123');
    });

    it('refuses a wrong token, so nothing is echoed', () => {
      expect(() => service.verifyHandshake('wrong', 'challenge-123')).toThrow(
        WebhookSignatureInvalidError,
      );
    });

    it('refuses when no verify token is configured', () => {
      expect(() => build({}).verifyHandshake('anything', 'challenge-123')).toThrow(
        WebhookChannelNotConfiguredError,
      );
    });
  });

  describe('an inbound delivery', () => {
    it('stores the payload and enqueues the stored row', async () => {
      await expect(service.ingestWhatsApp(RAW_BODY, sign(RAW_BODY))).resolves.toBe('stored');

      expect(store).toHaveBeenCalledWith('whatsapp', expect.any(String), expect.any(Object));
      expect(enqueue).toHaveBeenCalledWith(
        WEBHOOKS_QUEUE,
        PROCESS_WEBHOOK_EVENT_JOB,
        { tenantId: null, webhookEventId: 'event-1' },
        expect.objectContaining({ jobId: 'webhook-event-event-1' }),
      );
    });

    it('stores the parsed payload, not the raw text', async () => {
      await service.ingestWhatsApp(RAW_BODY, sign(RAW_BODY));

      expect(storeCall(0)[2]).toEqual(JSON.parse(RAW_BODY.toString('utf8')));
    });

    /**
     * The `provider_event_id` Meta does not give us. A retry replays the exact
     * bytes, so the digest is the same and the unique constraint absorbs it.
     */
    it('derives the same provider event id for a byte-identical retry', async () => {
      await service.ingestWhatsApp(RAW_BODY, sign(RAW_BODY));
      await service.ingestWhatsApp(Buffer.from(RAW_BODY), sign(RAW_BODY));

      expect(storeCall(0)[1]).toBe(storeCall(1)[1]);
    });

    it('derives a different provider event id for a different delivery', async () => {
      const other = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));

      await service.ingestWhatsApp(RAW_BODY, sign(RAW_BODY));
      await service.ingestWhatsApp(other, sign(other));

      expect(storeCall(0)[1]).not.toBe(storeCall(1)[1]);
    });

    it('does not enqueue a delivery the unique constraint absorbed', async () => {
      store.mockResolvedValue(null);

      await expect(service.ingestWhatsApp(RAW_BODY, sign(RAW_BODY))).resolves.toBe('duplicate');
      expect(enqueue).not.toHaveBeenCalled();
    });

    /**
     * ADR 0001's durability rule, as behaviour: the payload is already in
     * Postgres, so a queue that is down is lateness, not loss, and must not turn
     * into a 500 that makes Meta retry.
     */
    it('reports success even when the queue is unavailable', async () => {
      enqueue.mockResolvedValue(false);

      await expect(service.ingestWhatsApp(RAW_BODY, sign(RAW_BODY))).resolves.toBe('stored');
    });
  });

  describe('refusing a delivery', () => {
    it.each([
      ['a wrong signature', 'sha256=00'],
      ['no signature header', undefined],
    ])('stores nothing when there is %s', async (_case, header) => {
      await expect(service.ingestWhatsApp(RAW_BODY, header)).rejects.toThrow(
        WebhookSignatureInvalidError,
      );

      expect(store).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('fails closed, storing nothing, when no app secret is configured', async () => {
      const unconfigured = build({});

      await expect(unconfigured.ingestWhatsApp(RAW_BODY, sign(RAW_BODY))).rejects.toThrow(
        WebhookChannelNotConfiguredError,
      );

      expect(store).not.toHaveBeenCalled();
    });
  });
});
