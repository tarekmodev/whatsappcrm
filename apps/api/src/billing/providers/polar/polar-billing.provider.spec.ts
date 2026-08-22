import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { BillingEventProcessor } from '../../billing-event.processor';
import type { SeatSyncService } from '../../seat-sync.service';
import type { SubscriptionSyncService } from '../../subscription-sync.service';
import type { SystemPrisma } from '../../../prisma/prisma.tokens';
import type { TenantLifecycleService } from '../../../tenancy/lifecycle/tenant-lifecycle.service';
import type { WebhookEventsRepository } from '../../../webhooks/webhook-events.repository';
import { PolarBillingProvider } from './polar-billing.provider';

const TENANT = '0192f0ff-0000-7000-8000-0000000000a1';
const ROW_ID = '0192f0ff-0000-7000-8000-0000000000f1';
const WEBHOOK_ID = 'wh_01k3n0h0c9e0v9m6k9q6qk8r5x';
const WEBHOOK_SECRET = 'polar_whsec_tar663_local_only';

const PERIOD_START = '2026-08-01T00:00:00.000Z';
const PERIOD_END = '2026-09-01T00:00:00.000Z';

/**
 * A `subscription.active` delivery as **Polar actually posts it**: snake_case
 * JSON, ISO instants, and the embedded customer and product objects the mapper
 * does not read.
 *
 * Fields and spellings are taken from `@polar-sh/sdk`'s own inbound schema for
 * `Subscription`, which is the authority on the wire format short of a live
 * sandbox — the SDK maps `customer_id → customerId`, `current_period_start →
 * currentPeriodStart` and so on, and it is that mapping the adapter used to
 * assume had already happened.
 *
 * It is deliberately **not** schema-complete against that SDK model: a payload
 * that satisfied it in full would have to embed a whole customer, product and
 * price union, and asserting on it would be testing Polar's zod schemas rather
 * than our mapping. Everything the adapter reads is here, spelled as Polar
 * spells it, which is the thing that was wrong.
 */
function activationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'subscription.active',
    timestamp: '2026-08-01T00:00:05.482913Z',
    data: {
      id: 'sub_01k3n0f4q2b7wq0f2rp3m4d5c6',
      created_at: '2026-08-01T00:00:04.111000Z',
      modified_at: '2026-08-01T00:00:05.101000Z',
      status: 'active',
      amount: 4900,
      currency: 'usd',
      recurring_interval: 'month',
      current_period_start: PERIOD_START,
      current_period_end: PERIOD_END,
      cancel_at_period_end: false,
      canceled_at: null,
      started_at: PERIOD_START,
      ends_at: null,
      customer_id: 'cus_01k3n0dyf9x2s3t4u5v6w7x8y9',
      product_id: 'prod_01k3n0c1a2b3c4d5e6f7g8h9j0',
      discount_id: null,
      checkout_id: 'chk_01k3n0b0z1y2x3w4v5u6t7s8r9',
      seats: 7,
      metadata: { tenant_id: TENANT, plan_key: 'growth' },
      custom_field_data: {},
      customer: {
        id: 'cus_01k3n0dyf9x2s3t4u5v6w7x8y9',
        email: 'billing@example.test',
        external_id: TENANT,
      },
      product: { id: 'prod_01k3n0c1a2b3c4d5e6f7g8h9j0', name: 'Growth', is_recurring: true },
      prices: [{ id: 'price_01k3n0a9', amount_type: 'fixed', price_amount: 4900 }],
      ...(overrides.data as Record<string, unknown> | undefined),
    },
    ...overrides,
  };
}

function provider(): PolarBillingProvider {
  const config = {
    get: (key: string) => (key === 'POLAR_WEBHOOK_SECRET' ? WEBHOOK_SECRET : undefined),
    getOrThrow: (key: string) => (key === 'POLAR_ENVIRONMENT' ? 'sandbox' : 5_000),
  } as unknown as ConfigService;

  return new PolarBillingProvider(config);
}

/**
 * Standard Webhooks' signature over the exact bytes, computed here rather than
 * taken from the library the adapter verifies with — a test that signs with the
 * same helper it is testing proves only that the helper agrees with itself.
 *
 * Polar base64-encodes the configured secret before handing it to
 * `standardwebhooks`, which base64-decodes it again, so the HMAC key is the
 * secret's own UTF-8 bytes.
 */
function sign(rawBody: Buffer, headers: { id: string; timestampSeconds: number }): string {
  const signature = createHmac('sha256', Buffer.from(WEBHOOK_SECRET, 'utf8'))
    .update(`${headers.id}.${headers.timestampSeconds}.${rawBody.toString('utf8')}`)
    .digest('base64');

  return `v1,${signature}`;
}

/** A signed delivery: the raw bytes and the three headers Polar sends with them. */
function delivery(payload: Record<string, unknown>): {
  rawBody: Buffer;
  headers: Record<string, string>;
} {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  const timestampSeconds = Math.floor(Date.now() / 1_000);

  return {
    rawBody,
    headers: {
      'webhook-id': WEBHOOK_ID,
      'webhook-timestamp': String(timestampSeconds),
      'webhook-signature': sign(rawBody, { id: WEBHOOK_ID, timestampSeconds }),
    },
  };
}

/**
 * The worker, wired to the **real** Polar adapter and the real mapper. Only the
 * repository, the two writers and the lifecycle are stubbed, so everything
 * between a stored payload and the subscription write is under test.
 */
function processorFor(payload: unknown) {
  const markProcessed = jest.fn().mockResolvedValue(undefined);
  const markFailed = jest.fn().mockResolvedValue(undefined);
  const apply = jest.fn().mockResolvedValue({ result: 'applied', planKey: 'growth', seats: 7 });
  const applyBillingEvent = jest.fn().mockResolvedValue(undefined);

  const processor = new BillingEventProcessor(
    { getOrThrow: () => 5 } as unknown as ConfigService,
    provider(),
    {
      subscription: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    } as unknown as SystemPrisma,
    {
      claim: jest
        .fn()
        .mockResolvedValue({ id: ROW_ID, providerEventId: WEBHOOK_ID, payload, attempts: 1 }),
      markProcessed,
      markFailed,
      recordAttemptFailure: jest.fn().mockResolvedValue(undefined),
    } as unknown as WebhookEventsRepository,
    { apply } as unknown as SubscriptionSyncService,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as unknown as SeatSyncService,
    { applyBillingEvent } as unknown as TenantLifecycleService,
  );

  return { processor, apply, applyBillingEvent, markProcessed, markFailed };
}

/**
 * The `polar` driver against Polar's real payload shape — the regression suite
 * for TAR-663.
 *
 * Everything else in this module was exercised only through `FakeBillingProvider`
 * or through mapper fixtures written in the SDK's camelCase, so a delivery that
 * looked exactly like this one parsed to nothing and was marked `processed`: a
 * tenant that completed checkout was never activated, and no row, log or alert
 * said so. These tests run the stored payload through the adapter that ships.
 */
describe('the Polar driver receiving a real webhook', () => {
  beforeEach(() => {
    // The adapter logs an accepted-but-untypeable delivery at warn; the
    // assertions are about the outcome, not the noise.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('the signature', () => {
    it('accepts a genuinely signed delivery', () => {
      const { rawBody, headers } = delivery(activationPayload());

      expect(provider().verifyWebhookSignature(rawBody, headers)).toBe(true);
    });

    it('refuses one signed with the wrong secret, and never throws', () => {
      const { rawBody, headers } = delivery(activationPayload());

      expect(
        provider().verifyWebhookSignature(rawBody, { ...headers, 'webhook-signature': 'v1,nope' }),
      ).toBe(false);
    });

    it('refuses one with a header missing', () => {
      const { rawBody, headers } = delivery(activationPayload());

      expect(
        provider().verifyWebhookSignature(rawBody, { ...headers, 'webhook-id': undefined }),
      ).toBe(false);
    });

    /**
     * `validateEvent` verifies the signature and *then* parses the body against
     * the schemas pinned in this SDK version. An event type newer than the SDK
     * is authentic and unparseable at once — and rethrowing made it a 500, ten of
     * which disable the endpoint at Polar. It is accepted and stored instead.
     */
    it('accepts an authentic delivery the pinned SDK cannot type', () => {
      const { rawBody, headers } = delivery({
        type: 'subscription.something_polar_added_later',
        timestamp: '2026-08-01T00:00:05.482913Z',
        data: { id: 'sub_x' },
      });

      expect(provider().verifyWebhookSignature(rawBody, headers)).toBe(true);
    });
  });

  describe('reading the payload', () => {
    it('finds the tenant, the subscription and the customer on the wire shape', () => {
      const payload = activationPayload();

      expect(provider().readWebhookSubject(payload)).toEqual({
        tenantId: TENANT,
        providerSubscriptionId: 'sub_01k3n0f4q2b7wq0f2rp3m4d5c6',
        providerCustomerId: 'cus_01k3n0dyf9x2s3t4u5v6w7x8y9',
      });
    });

    it('translates it into an activation, product id included', () => {
      const parsed = provider().parseWebhookEvent(
        activationPayload(),
        { 'webhook-id': WEBHOOK_ID },
        TENANT,
      );

      expect(parsed).toMatchObject({
        outcome: 'event',
        event: {
          type: 'subscription.activated',
          tenantId: TENANT,
          providerEventId: WEBHOOK_ID,
          status: 'active',
          seats: 7,
          currentPeriodStart: PERIOD_START,
          currentPeriodEnd: PERIOD_END,
          occurredAt: '2026-08-01T00:00:05.482Z',
          providerProductId: 'prod_01k3n0c1a2b3c4d5e6f7g8h9j0',
        },
      });
    });
  });

  /**
   * The acceptance criterion itself: a real subscription-lifecycle webhook,
   * stored exactly as it was signed, reaches the subscription writer as an
   * activation.
   */
  it('activates the tenant end to end, from the stored payload', async () => {
    const { rawBody, headers } = delivery(activationPayload());
    const adapter = provider();

    expect(adapter.verifyWebhookSignature(rawBody, headers)).toBe(true);

    // Exactly what `BillingWebhookService` stores: the raw bytes re-parsed, so
    // what the worker reads is provably what was signed.
    const stored: unknown = JSON.parse(rawBody.toString('utf8'));
    const { processor, apply, applyBillingEvent, markProcessed, markFailed } = processorFor(stored);

    await processor.process(ROW_ID);

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'subscription.activated',
        tenantId: TENANT,
        status: 'active',
        seats: 7,
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        providerSubscriptionId: 'sub_01k3n0f4q2b7wq0f2rp3m4d5c6',
        providerCustomerId: 'cus_01k3n0dyf9x2s3t4u5v6w7x8y9',
        providerProductId: 'prod_01k3n0c1a2b3c4d5e6f7g8h9j0',
      }),
    );
    expect(applyBillingEvent).toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalledWith(ROW_ID, TENANT);
    expect(markFailed).not.toHaveBeenCalled();
  });

  /**
   * The other half of the fix. A subscribed event whose data will not read is
   * parked with the payload intact — never recorded as processed, which is what
   * made the original failure invisible.
   */
  it('parks a subscribed event whose data it cannot read', async () => {
    const { processor, apply, markProcessed, markFailed } = processorFor({
      type: 'subscription.active',
      timestamp: '2026-08-01T00:00:05.482913Z',
      data: { metadata: { tenant_id: TENANT }, nothing: 'we can read' },
    });

    await processor.process(ROW_ID);

    expect(markFailed).toHaveBeenCalledWith(
      ROW_ID,
      expect.stringContaining('unrecognised_payload'),
      TENANT,
    );
    expect(markProcessed).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  /** An event nobody subscribed to still costs one no-op, not a parked row. */
  it('records an event it does not subscribe to as processed', async () => {
    const { processor, apply, markProcessed, markFailed } = processorFor({
      type: 'benefit_grant.created',
      timestamp: '2026-08-01T00:00:05.482913Z',
      data: { id: 'bg_1', metadata: { tenant_id: TENANT } },
    });

    await processor.process(ROW_ID);

    expect(markProcessed).toHaveBeenCalledWith(ROW_ID, TENANT);
    expect(markFailed).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});
