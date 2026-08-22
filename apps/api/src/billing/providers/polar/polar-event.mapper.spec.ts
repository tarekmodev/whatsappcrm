import type { BillingEvent, ParsedWebhookEvent } from '@whatsappcrm/contracts';
import {
  readProviderCustomerId,
  readProviderProductId,
  readProviderSubscriptionId,
  readTenantIdFromMetadata,
  toBillingEvent,
} from './polar-event.mapper';

const TENANT = '0192f0ff-0000-7000-8000-0000000000a1';
const EVENT_ID = 'msg_2h4k9';
const RECEIVED_AT = new Date('2026-08-22T09:00:00.000Z');

const PERIOD_START = '2026-08-01T00:00:00.000Z';
const PERIOD_END = '2026-09-01T00:00:00.000Z';

/**
 * What a fixture may vary, in **our** spelling. Each builder below renders it in
 * one of Polar's two, so a test says `{ status: 'past_due' }` once and both
 * spellings are exercised with it.
 */
interface SubscriptionOverrides {
  id?: string;
  status?: string;
  customerId?: string | null;
  productId?: string | null;
  seats?: number | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  endsAt?: string | null;
  metadata?: Record<string, unknown>;
}

const SUBSCRIPTION_DEFAULTS: Required<SubscriptionOverrides> = {
  id: 'sub_abc',
  status: 'active',
  customerId: 'cus_abc',
  productId: 'prod_abc',
  seats: 5,
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  cancelAtPeriodEnd: false,
  endsAt: null,
  metadata: { tenant_id: TENANT },
};

/**
 * A Polar subscription in the shape the **SDK** hands back: camelCase, `Date`
 * instants. This is what `getSubscription` and `resolveCheckout` see.
 */
function sdkSubscription(overrides: SubscriptionOverrides = {}): Record<string, unknown> {
  const fixture = { ...SUBSCRIPTION_DEFAULTS, ...overrides };

  return {
    id: fixture.id,
    status: fixture.status,
    customerId: fixture.customerId,
    productId: fixture.productId,
    seats: fixture.seats,
    currentPeriodStart: asDate(fixture.currentPeriodStart),
    currentPeriodEnd: asDate(fixture.currentPeriodEnd),
    cancelAtPeriodEnd: fixture.cancelAtPeriodEnd,
    endsAt: asDate(fixture.endsAt),
    startedAt: asDate(fixture.currentPeriodStart),
    metadata: fixture.metadata,
  };
}

/**
 * The same subscription as it actually arrives on a **webhook**: Polar's
 * snake_case JSON with ISO strings, carrying the fields the mapper does not read
 * as well as the ones it does.
 *
 * This is the fixture TAR-663 turned on. The mapper was written against the SDK
 * shape above and only ever tested against it, so every real delivery — which
 * looks like this — mapped to nothing and was recorded as processed.
 */
function wireSubscription(overrides: SubscriptionOverrides = {}): Record<string, unknown> {
  const fixture = { ...SUBSCRIPTION_DEFAULTS, ...overrides };

  return {
    id: fixture.id,
    created_at: '2026-07-01T09:12:33.123456Z',
    modified_at: '2026-08-01T00:00:04.998201Z',
    status: fixture.status,
    amount: 4900,
    currency: 'usd',
    recurring_interval: 'month',
    current_period_start: fixture.currentPeriodStart,
    current_period_end: fixture.currentPeriodEnd,
    cancel_at_period_end: fixture.cancelAtPeriodEnd,
    canceled_at: null,
    started_at: fixture.currentPeriodStart,
    ends_at: fixture.endsAt,
    customer_id: fixture.customerId,
    product_id: fixture.productId,
    discount_id: null,
    checkout_id: 'chk_9f2',
    customer_cancellation_reason: null,
    customer_cancellation_comment: null,
    seats: fixture.seats,
    metadata: fixture.metadata,
    custom_field_data: {},
    // The heavy objects Polar embeds. They are why the mapper declares its own
    // shape rather than importing the SDK's, and they must not get in its way.
    customer: { id: fixture.customerId, email: 'ops@example.test', external_id: TENANT },
    product: { id: fixture.productId, name: 'Growth', is_recurring: true, prices: [] },
    prices: [{ id: 'price_1', amount_type: 'fixed', price_amount: 4900 }],
  };
}

/** What an order fixture may vary, again in our spelling. */
interface OrderOverrides {
  subscriptionId?: string | null;
  /** `null` for an order that embeds no subscription; `{}` for one that carries nothing useful. */
  subscription?: Record<string, unknown> | null;
}

/** An order in the SDK's spelling. */
function sdkOrder(overrides: OrderOverrides = {}): Record<string, unknown> {
  const { subscriptionId = 'sub_abc', subscription = null } = overrides;

  return {
    id: 'ord_abc',
    customerId: 'cus_abc',
    subscriptionId,
    productId: 'prod_abc',
    subscription: subscription ?? {
      id: 'sub_abc',
      status: 'active',
      currentPeriodStart: asDate(PERIOD_START),
      currentPeriodEnd: asDate(PERIOD_END),
      seats: 5,
    },
  };
}

/** The same order as Polar posts it. */
function wireOrder(overrides: OrderOverrides = {}): Record<string, unknown> {
  const { subscriptionId = 'sub_abc', subscription = null } = overrides;

  return {
    id: 'ord_abc',
    created_at: '2026-08-01T00:00:03.000000Z',
    status: 'paid',
    paid: true,
    total_amount: 4900,
    currency: 'usd',
    billing_reason: 'subscription_cycle',
    customer_id: 'cus_abc',
    product_id: 'prod_abc',
    subscription_id: subscriptionId,
    checkout_id: 'chk_9f2',
    metadata: { tenant_id: TENANT },
    subscription: subscription ?? {
      id: 'sub_abc',
      status: 'active',
      current_period_start: PERIOD_START,
      current_period_end: PERIOD_END,
      customer_id: 'cus_abc',
      product_id: 'prod_abc',
      seats: 5,
    },
  };
}

function asDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function map(type: string, data: unknown, timestamp?: Date | string): ParsedWebhookEvent {
  return toBillingEvent({
    envelope: { type, data, timestamp },
    tenantId: TENANT,
    providerEventId: EVENT_ID,
    receivedAt: RECEIVED_AT,
  });
}

/** The event a mapping produced, or a failure that names what came out instead. */
function eventOf(type: string, data: unknown, timestamp?: Date | string): BillingEvent {
  const parsed = map(type, data, timestamp);

  if (parsed.outcome !== 'event') {
    throw new Error(
      `expected ${type} to map to an event, got ${parsed.outcome}` +
        (parsed.outcome === 'unreadable' ? `: ${parsed.detail}` : ''),
    );
  }

  return parsed.event;
}

/**
 * The adapter's whole job, and the file with the most ways to be quietly wrong.
 *
 * Every assertion below is about a *mapping* rather than about Polar: the point
 * of `BillingEvent` is that nothing downstream can tell which provider produced
 * it, so these are the tests that would catch a second provider being wired in
 * with different semantics under the same union.
 *
 * **Every case runs twice**, once per spelling — the SDK's camelCase objects and
 * the snake_case JSON a webhook actually delivers. TAR-663 is what that costs
 * when it is only done once: the suite was green against the SDK shape while
 * every real delivery mapped to nothing.
 */
describe.each([
  ['the SDK shape', sdkSubscription, sdkOrder],
  ["Polar's wire shape", wireSubscription, wireOrder],
])('the Polar → BillingEvent mapping, given %s', (_name, subscription, order) => {
  it('maps an activation, carrying the period, the seats and both provider ids', () => {
    expect(eventOf('subscription.active', subscription())).toMatchObject({
      type: 'subscription.activated',
      tenantId: TENANT,
      providerEventId: EVENT_ID,
      status: 'active',
      seats: 5,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      providerSubscriptionId: 'sub_abc',
      providerCustomerId: 'cus_abc',
    });
  });

  /**
   * The single most consequential mapping in the file. Polar fires
   * `subscription.canceled` when a customer *requests* cancellation and is still
   * paid through the period end; `TENANT_STATUS_EFFECTS.cancelled` sets
   * `apiAccess: false`. Mapping one onto the other would lock a tenant out of a
   * period they have already paid for, the same day they clicked cancel.
   */
  it('treats a requested cancellation as an update, never as a cancellation', () => {
    const event = eventOf(
      'subscription.canceled',
      subscription({ cancelAtPeriodEnd: true, endsAt: PERIOD_END }),
    );

    expect(event).toMatchObject({
      type: 'subscription.updated',
      cancelAtPeriodEnd: true,
      cancelsAt: PERIOD_END,
    });
  });

  it('clears the pending cancellation when it is withdrawn', () => {
    const event = eventOf('subscription.uncanceled', subscription({ cancelAtPeriodEnd: false }));

    expect(event).toMatchObject({
      type: 'subscription.updated',
      cancelAtPeriodEnd: false,
      cancelsAt: null,
    });
  });

  /** Access ends when the provider says access has ended, and not before. */
  it('maps a revocation onto our cancellation', () => {
    expect(eventOf('subscription.revoked', subscription({ status: 'canceled' }))).toMatchObject({
      type: 'subscription.canceled',
      status: 'canceled',
    });
  });

  it('maps a past-due report onto the dunning event', () => {
    expect(eventOf('subscription.past_due', subscription({ status: 'past_due' }))).toMatchObject({
      type: 'subscription.past_due',
      status: 'past_due',
    });
  });

  /**
   * A status change into `past_due` reported as an amendment is a failed charge,
   * and `lifecycle_events` records what *moved* the tenant — so the cause has to
   * survive the mapping rather than being flattened into "something updated".
   */
  it('reads an update that lands in past_due as a failed payment', () => {
    expect(eventOf('subscription.updated', subscription({ status: 'past_due' }))).toMatchObject({
      type: 'payment.failed',
      status: 'past_due',
    });
  });

  it('leaves an ordinary update as an update', () => {
    expect(eventOf('subscription.updated', subscription({ seats: 9 }))).toMatchObject({
      type: 'subscription.updated',
      seats: 9,
    });
  });

  /**
   * A created subscription may not be paid for yet. Acting on both this and
   * `subscription.active` would activate a tenant whose first payment has not
   * settled.
   */
  it('drops subscription.created, because activation is a different event', () => {
    expect(map('subscription.created', subscription({ status: 'incomplete' }))).toEqual({
      outcome: 'ignored',
    });
  });

  it('drops everything it does not subscribe to', () => {
    for (const type of [
      'benefit_grant.created',
      'customer.state_changed',
      'checkout.updated',
      'customer_seat.claimed',
      'organization.updated',
    ]) {
      expect(map(type, subscription())).toEqual({ outcome: 'ignored' });
    }
  });

  describe('order.paid', () => {
    it('is a succeeded payment when it belongs to a subscription', () => {
      expect(eventOf('order.paid', order())).toMatchObject({
        type: 'payment.succeeded',
        status: 'active',
        seats: 5,
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        providerSubscriptionId: 'sub_abc',
        providerCustomerId: 'cus_abc',
      });
    });

    /**
     * A renewal receipt says nothing about which plan the tenant is on, and the
     * writer treats `planKey: null` as "leave the column alone". Inventing one
     * here would let a receipt overwrite a plan with a guess.
     */
    it('names no plan, because an order does not carry one', () => {
      expect(eventOf('order.paid', order({ subscription: {} })).planKey).toBeNull();
    });

    it('is dropped when it is not for a subscription', () => {
      expect(map('order.paid', order({ subscriptionId: null }))).toEqual({ outcome: 'ignored' });
    });

    /** An order with no customer id is not one we can read at all. */
    it('is unreadable when it names no customer', () => {
      expect(map('order.paid', { id: 'ord_x' })).toMatchObject({ outcome: 'unreadable' });
    });
  });

  describe('status vocabulary', () => {
    /**
     * Polar carries three states `SUBSCRIPTION_STATUSES` does not. Each maps onto
     * its nearest neighbour in the direction that cannot widen what a tenant may
     * do — which is what keeps the published union provider-neutral rather than
     * the union of every provider's vocabulary.
     */
    it.each([
      ['incomplete_expired', 'incomplete'],
      ['unpaid', 'past_due'],
      ['paused', 'canceled'],
      ['trialing', 'trialing'],
    ])('narrows %s to %s', (polar, ours) => {
      expect(eventOf('subscription.active', subscription({ status: polar })).status).toBe(ours);
    });

    it('reports a status it has never seen as unknown rather than guessing', () => {
      expect(
        eventOf('subscription.active', subscription({ status: 'something_new' })).status,
      ).toBeNull();
    });
  });

  describe('the envelope timestamp', () => {
    /**
     * `occurredAt` is what `subscriptions.last_event_at` compares against, so a
     * timestamp that did not survive the round trip out of `webhook_events`
     * would defeat the entire out-of-order defence.
     */
    it('reads a Date, as the SDK parses it', () => {
      expect(
        eventOf('subscription.active', subscription(), new Date('2026-08-20T10:00:00.000Z'))
          .occurredAt,
      ).toBe('2026-08-20T10:00:00.000Z');
    });

    it('reads an ISO string, as the stored payload holds it', () => {
      expect(
        eventOf('subscription.active', subscription(), '2026-08-20T10:00:00.000Z').occurredAt,
      ).toBe('2026-08-20T10:00:00.000Z');
    });

    it('falls back to receipt time when there is none, which is the conservative direction', () => {
      expect(eventOf('subscription.active', subscription()).occurredAt).toBe(
        RECEIVED_AT.toISOString(),
      );
    });
  });

  describe('reading a payload defensively', () => {
    /**
     * Unreadable, **not** ignored: this is an event we subscribe to, so nothing
     * came out of it that should have. The receiver parks it; recording it as
     * processed is exactly how TAR-663 lost every activation.
     */
    it('reports a subscribed event it cannot read, rather than dropping it', () => {
      const parsed = map('subscription.active', { nothing: 'useful' });

      expect(parsed.outcome).toBe('unreadable');
      expect(parsed.outcome === 'unreadable' && parsed.detail).toContain('subscription.active');
      expect(map('subscription.active', null).outcome).toBe('unreadable');
    });

    it('names the payload keys in the reason, so the shortfall is diagnosable', () => {
      const parsed = map('subscription.active', { id: 'sub_x', status: 'active' });

      expect(parsed.outcome === 'unreadable' && parsed.detail).toContain('status');
    });

    it('finds the tenant id we stamped at checkout', () => {
      expect(readTenantIdFromMetadata(subscription())).toBe(TENANT);
    });

    /**
     * Polar's metadata values may be numbers or booleans. A tenant id that
     * arrived as anything but a string is not one we can scope a write to, and
     * the receiver's provider-id fallbacks are what cover the case.
     */
    it('ignores metadata that is not a string tenant id', () => {
      expect(readTenantIdFromMetadata(subscription({ metadata: { tenant_id: 42 } }))).toBeNull();
      expect(readTenantIdFromMetadata(subscription({ metadata: {} }))).toBeNull();
      expect(readTenantIdFromMetadata({})).toBeNull();
    });

    /**
     * The fallbacks the receiver uses when metadata is absent — a subscription
     * created before we started stamping it. Reading only the SDK spelling here
     * left those two branches dead against every real delivery.
     */
    it('reports the provider ids the receiver falls back to', () => {
      expect(readProviderSubscriptionId('subscription.active', subscription())).toBe('sub_abc');
      expect(readProviderSubscriptionId('order.paid', order())).toBe('sub_abc');
      expect(readProviderCustomerId(subscription())).toBe('cus_abc');
      expect(readProviderProductId(subscription())).toBe('prod_abc');
    });
  });
});
