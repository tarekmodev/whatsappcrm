import type { ConfigService } from '@nestjs/config';
import type {
  BillingEvent,
  BillingProvider,
  ParsedWebhookEvent,
  WebhookSubject,
} from '@whatsappcrm/contracts';
import type { SystemPrisma } from '../prisma/prisma.tokens';
import type { TenantLifecycleService } from '../tenancy/lifecycle/tenant-lifecycle.service';
import type { WebhookEventsRepository } from '../webhooks/webhook-events.repository';
import { BillingEventProcessor } from './billing-event.processor';
import type { SeatSyncService } from './seat-sync.service';
import type { SubscriptionSyncService } from './subscription-sync.service';
import type { SubscriptionSyncOutcome } from './subscription-sync.service';

const TENANT = '0192f0ff-0000-7000-8000-0000000000a1';
const ROW_ID = '0192f0ff-0000-7000-8000-0000000000f1';

const EVENT: BillingEvent = {
  type: 'subscription.activated',
  tenantId: TENANT,
  providerEventId: 'msg_1',
  planKey: 'growth',
  seats: 5,
  status: 'active',
  currentPeriodStart: '2026-08-01T00:00:00.000Z',
  currentPeriodEnd: '2026-09-01T00:00:00.000Z',
  occurredAt: '2026-08-22T09:00:00.000Z',
};

interface Harness {
  claimed?: { id: string; providerEventId: string; payload: unknown; attempts: number } | null;
  subject?: WebhookSubject;
  parsed?: ParsedWebhookEvent;
  outcome?: SubscriptionSyncOutcome;
  findUnique?: jest.Mock;
  findFirst?: jest.Mock;
}

function processorWith(options: Harness) {
  const claim = jest
    .fn()
    .mockResolvedValue(
      options.claimed === undefined
        ? { id: ROW_ID, providerEventId: 'msg_1', payload: {}, attempts: 1 }
        : options.claimed,
    );
  const markProcessed = jest.fn().mockResolvedValue(undefined);
  const markFailed = jest.fn().mockResolvedValue(undefined);
  const recordAttemptFailure = jest.fn().mockResolvedValue(undefined);

  const readWebhookSubject = jest.fn().mockReturnValue(
    options.subject ?? {
      tenantId: TENANT,
      providerSubscriptionId: null,
      providerCustomerId: null,
    },
  );
  const parseWebhookEvent = jest
    .fn()
    .mockReturnValue(options.parsed ?? ({ outcome: 'event', event: EVENT } as const));

  const apply = jest
    .fn()
    .mockResolvedValue(
      options.outcome ?? ({ result: 'applied', planKey: 'growth', seats: 5 } as const),
    );
  const applyBillingEvent = jest.fn().mockResolvedValue(undefined);
  const enqueueSeats = jest.fn().mockResolvedValue(undefined);

  const findUnique = options.findUnique ?? jest.fn().mockResolvedValue(null);
  const findFirst = options.findFirst ?? jest.fn().mockResolvedValue(null);

  const processor = new BillingEventProcessor(
    { getOrThrow: () => 5 } as unknown as ConfigService,
    { readWebhookSubject, parseWebhookEvent } as unknown as BillingProvider,
    { subscription: { findUnique, findFirst } } as unknown as SystemPrisma,
    {
      claim,
      markProcessed,
      markFailed,
      recordAttemptFailure,
    } as unknown as WebhookEventsRepository,
    { apply } as unknown as SubscriptionSyncService,
    { enqueue: enqueueSeats } as unknown as SeatSyncService,
    { applyBillingEvent } as unknown as TenantLifecycleService,
  );

  return {
    processor,
    claim,
    markProcessed,
    markFailed,
    apply,
    applyBillingEvent,
    enqueueSeats,
    parseWebhookEvent,
    findUnique,
    findFirst,
  };
}

/**
 * The worker half. It runs against the durable row rather than an HTTP request,
 * which is what makes every decision here retriable — and what these tests are
 * mostly about.
 */
describe('BillingEventProcessor', () => {
  /**
   * The second layer of the replay defence, under the unique constraint on
   * `(provider, provider_event_id)`. A provider retry, a sweeper re-enqueue and
   * an expired job lock all land here.
   */
  it('does nothing for a row it cannot claim', async () => {
    const { processor, apply, applyBillingEvent, markProcessed } = processorWith({ claimed: null });

    await processor.process(ROW_ID);

    expect(apply).not.toHaveBeenCalled();
    expect(applyBillingEvent).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
  });

  describe('resolving the tenant', () => {
    it('takes the metadata we stamped at checkout, with no query at all', async () => {
      const { processor, parseWebhookEvent, findUnique, findFirst } = processorWith({});

      await processor.process(ROW_ID);

      expect(parseWebhookEvent).toHaveBeenCalledWith(expect.anything(), expect.anything(), TENANT);
      expect(findUnique).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('falls back to the provider subscription id', async () => {
      const { processor, parseWebhookEvent, findUnique } = processorWith({
        subject: {
          tenantId: null,
          providerSubscriptionId: 'sub_abc',
          providerCustomerId: null,
        },
        findUnique: jest.fn().mockResolvedValue({ tenantId: TENANT }),
      });

      await processor.process(ROW_ID);

      expect(findUnique).toHaveBeenCalledWith({
        where: { providerSubscriptionId: 'sub_abc' },
        select: { tenantId: true },
      });
      expect(parseWebhookEvent).toHaveBeenCalledWith(expect.anything(), expect.anything(), TENANT);
    });

    it('then to the provider customer id', async () => {
      const { processor, findFirst, parseWebhookEvent } = processorWith({
        subject: {
          tenantId: null,
          providerSubscriptionId: null,
          providerCustomerId: 'cus_abc',
        },
        findFirst: jest.fn().mockResolvedValue({ tenantId: TENANT }),
      });

      await processor.process(ROW_ID);

      expect(findFirst).toHaveBeenCalled();
      expect(parseWebhookEvent).toHaveBeenCalledWith(expect.anything(), expect.anything(), TENANT);
    });

    /**
     * Parked, and the delivery was still answered 200 by the controller. A 4xx
     * or 5xx would make the provider retry an event that will never resolve, and
     * ten of those disable the endpoint.
     */
    it('parks an event whose tenant cannot be established', async () => {
      const { processor, markFailed, apply } = processorWith({
        subject: { tenantId: null, providerSubscriptionId: null, providerCustomerId: null },
      });

      await processor.process(ROW_ID);

      expect(markFailed).toHaveBeenCalledWith(ROW_ID, 'unresolved_tenant');
      expect(apply).not.toHaveBeenCalled();
    });
  });

  /**
   * An event we did not subscribe to is not a failure. Parking every
   * `benefit_grant.*` would fill the operator's `status = 'failed'` list with
   * noise that hides the rows that matter.
   */
  it('records an unsubscribed event as processed rather than parking it', async () => {
    const { processor, markProcessed, markFailed, apply } = processorWith({
      parsed: { outcome: 'ignored' },
    });

    await processor.process(ROW_ID);

    expect(markProcessed).toHaveBeenCalledWith(ROW_ID, TENANT);
    expect(markFailed).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  /**
   * The other half of that distinction, and the whole of TAR-663: a subscribed
   * event whose shape the adapter cannot read is **not** an event we did not ask
   * for. Recording it as processed is how every real Polar subscription webhook
   * disappeared silently and a paying tenant was never activated — so it is
   * parked, with the payload intact, for replay once the mapping is fixed.
   */
  it('parks a payload it cannot read, and never records it as processed', async () => {
    const { processor, markFailed, markProcessed, apply } = processorWith({
      parsed: { outcome: 'unreadable', detail: 'subscription.active carries no readable id' },
    });

    await processor.process(ROW_ID);

    expect(markFailed).toHaveBeenCalledWith(
      ROW_ID,
      expect.stringContaining('unrecognised_payload'),
      TENANT,
    );
    expect(markFailed).toHaveBeenCalledWith(
      ROW_ID,
      expect.stringContaining('subscription.active'),
      TENANT,
    );
    expect(markProcessed).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  describe('applying it', () => {
    /**
     * `applyBillingEvent` opens its own transaction and enqueues a notification
     * keyed on the row it writes, so running it inside the subscription
     * transaction would enqueue a job that starts before its row is visible.
     */
    it('drives the lifecycle only after the subscription write has committed', async () => {
      const order: string[] = [];
      const { processor, apply, applyBillingEvent } = processorWith({});

      apply.mockImplementation(() => {
        order.push('subscription');
        return Promise.resolve({ result: 'applied', planKey: 'growth', seats: 5 });
      });
      applyBillingEvent.mockImplementation(() => {
        order.push('lifecycle');
        return Promise.resolve();
      });

      await processor.process(ROW_ID);

      expect(order).toEqual(['subscription', 'lifecycle']);
    });

    /**
     * An event the row has already moved past writes nothing and must move no
     * tenant either — that is the whole point of the `last_event_at` guard.
     */
    it('moves nothing for an event that lost the out-of-order check', async () => {
      const { processor, applyBillingEvent, markProcessed } = processorWith({
        outcome: { result: 'stale' },
      });

      await processor.process(ROW_ID);

      expect(applyBillingEvent).not.toHaveBeenCalled();
      expect(markProcessed).toHaveBeenCalledWith(ROW_ID, TENANT);
    });

    /**
     * A new period is when a deferred seat *reduction* becomes billable: the
     * tenant has paid the old rate through the period it just left.
     */
    it('lets a period roll release a deferred seat reduction', async () => {
      const { processor, enqueueSeats } = processorWith({});

      await processor.process(ROW_ID);

      expect(enqueueSeats).toHaveBeenCalledWith(TENANT, { allowDecrease: true });
    });

    it('parks a plan nothing in the catalogue matches, because no retry invents one', async () => {
      const { processor, markFailed, applyBillingEvent } = processorWith({
        outcome: {
          result: 'unresolved_plan',
          detail: 'no plan carries provider_product_id prod_x',
        },
      });

      await processor.process(ROW_ID);

      expect(markFailed).toHaveBeenCalledWith(
        ROW_ID,
        expect.stringContaining('unresolved_plan'),
        TENANT,
      );
      expect(applyBillingEvent).not.toHaveBeenCalled();
    });
  });

  describe('transient failures', () => {
    it('rethrows so BullMQ retries, while the attempt budget lasts', async () => {
      const { processor, apply, markFailed } = processorWith({});

      apply.mockRejectedValue(new Error('connection reset'));

      await expect(processor.process(ROW_ID)).rejects.toThrow('connection reset');
      expect(markFailed).not.toHaveBeenCalled();
    });

    /**
     * Parked rather than left `processing`, so the sweeper stops re-enqueueing a
     * row that has had every attempt it is going to get — and so the operator's
     * `status = 'failed'` query is a complete list of what needs attention.
     */
    it('parks the row once the budget is spent', async () => {
      const { processor, apply, markFailed } = processorWith({
        claimed: { id: ROW_ID, providerEventId: 'msg_1', payload: {}, attempts: 5 },
      });

      apply.mockRejectedValue(new Error('connection reset'));

      await processor.process(ROW_ID);

      expect(markFailed).toHaveBeenCalledWith(ROW_ID, expect.any(String));
    });
  });

  /**
   * The worker runs off the stored row, so the original headers are gone.
   * `provider_event_id` **is** the `webhook-id` header, which is why the ingest
   * path keys idempotency on it.
   */
  it('reconstructs the webhook id from the claimed row', async () => {
    const { processor, parseWebhookEvent } = processorWith({
      claimed: { id: ROW_ID, providerEventId: 'msg_from_row', payload: {}, attempts: 1 },
    });

    await processor.process(ROW_ID);

    expect(parseWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      { 'webhook-id': 'msg_from_row' },
      TENANT,
    );
  });
});
