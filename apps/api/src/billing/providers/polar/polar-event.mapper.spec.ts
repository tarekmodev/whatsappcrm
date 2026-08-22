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

/**
 * A Polar subscription, in the shape the SDK hands back. Only the fields the
 * mapper reads — a full one would need a customer, a product and a price union
 * that no assertion here is about.
 */
function subscription(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sub_abc',
    status: 'active',
    customerId: 'cus_abc',
    productId: 'prod_abc',
    seats: 5,
    currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
    cancelAtPeriodEnd: false,
    endsAt: null,
    metadata: { tenant_id: TENANT },
    ...overrides,
  };
}

function map(type: string, data: unknown, timestamp?: Date | string) {
  return toBillingEvent({
    envelope: { type, data, timestamp },
    tenantId: TENANT,
    providerEventId: EVENT_ID,
    receivedAt: RECEIVED_AT,
  });
}

/**
 * The adapter's whole job, and the file with the most ways to be quietly wrong.
 *
 * Every assertion below is about a *mapping* rather than about Polar: the point
 * of `BillingEvent` is that nothing downstream can tell which provider produced
 * it, so these are the tests that would catch a second provider being wired in
 * with different semantics under the same union.
 */
describe('the Polar → BillingEvent mapping', () => {
  it('maps an activation, carrying the period, the seats and both provider ids', () => {
    const event = map('subscription.active', subscription());

    expect(event).toMatchObject({
      type: 'subscription.activated',
      tenantId: TENANT,
      providerEventId: EVENT_ID,
      status: 'active',
      seats: 5,
      currentPeriodStart: '2026-08-01T00:00:00.000Z',
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
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
    const event = map(
      'subscription.canceled',
      subscription({ cancelAtPeriodEnd: true, endsAt: new Date('2026-09-01T00:00:00.000Z') }),
    );

    expect(event).toMatchObject({
      type: 'subscription.updated',
      cancelAtPeriodEnd: true,
      cancelsAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('clears the pending cancellation when it is withdrawn', () => {
    const event = map('subscription.uncanceled', subscription({ cancelAtPeriodEnd: false }));

    expect(event).toMatchObject({
      type: 'subscription.updated',
      cancelAtPeriodEnd: false,
      cancelsAt: null,
    });
  });

  /** Access ends when the provider says access has ended, and not before. */
  it('maps a revocation onto our cancellation', () => {
    expect(map('subscription.revoked', subscription({ status: 'canceled' }))).toMatchObject({
      type: 'subscription.canceled',
      status: 'canceled',
    });
  });

  it('maps a past-due report onto the dunning event', () => {
    expect(map('subscription.past_due', subscription({ status: 'past_due' }))).toMatchObject({
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
    expect(map('subscription.updated', subscription({ status: 'past_due' }))).toMatchObject({
      type: 'payment.failed',
      status: 'past_due',
    });
  });

  it('leaves an ordinary update as an update', () => {
    expect(map('subscription.updated', subscription({ seats: 9 }))).toMatchObject({
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
    expect(map('subscription.created', subscription({ status: 'incomplete' }))).toBeNull();
  });

  it('drops everything it does not subscribe to', () => {
    for (const type of [
      'benefit_grant.created',
      'customer.state_changed',
      'checkout.updated',
      'customer_seat.claimed',
      'organization.updated',
    ]) {
      expect(map(type, subscription())).toBeNull();
    }
  });

  describe('order.paid', () => {
    it('is a succeeded payment when it belongs to a subscription', () => {
      const event = map('order.paid', {
        customerId: 'cus_abc',
        subscriptionId: 'sub_abc',
        subscription: {
          currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
          seats: 5,
        },
      });

      expect(event).toMatchObject({
        type: 'payment.succeeded',
        status: 'active',
        currentPeriodStart: '2026-09-01T00:00:00.000Z',
        providerSubscriptionId: 'sub_abc',
      });
    });

    /**
     * A renewal receipt says nothing about which plan the tenant is on, and the
     * writer treats `planKey: null` as "leave the column alone". Inventing one
     * here would let a receipt overwrite a plan with a guess.
     */
    it('names no plan, because an order does not carry one', () => {
      const event = map('order.paid', {
        customerId: 'cus_abc',
        subscriptionId: 'sub_abc',
        subscription: {},
      });

      expect(event?.planKey).toBeNull();
    });

    it('is dropped when it is not for a subscription', () => {
      expect(map('order.paid', { customerId: 'cus_abc', subscriptionId: null })).toBeNull();
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
      expect(map('subscription.active', subscription({ status: polar }))?.status).toBe(ours);
    });

    it('reports a status it has never seen as unknown rather than guessing', () => {
      expect(
        map('subscription.active', subscription({ status: 'something_new' }))?.status,
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
        map('subscription.active', subscription(), new Date('2026-08-20T10:00:00.000Z'))
          ?.occurredAt,
      ).toBe('2026-08-20T10:00:00.000Z');
    });

    it('reads an ISO string, as the stored payload holds it', () => {
      expect(
        map('subscription.active', subscription(), '2026-08-20T10:00:00.000Z')?.occurredAt,
      ).toBe('2026-08-20T10:00:00.000Z');
    });

    it('falls back to receipt time when there is none, which is the conservative direction', () => {
      expect(map('subscription.active', subscription())?.occurredAt).toBe(
        RECEIVED_AT.toISOString(),
      );
    });
  });

  describe('reading a payload defensively', () => {
    it('refuses a body that is not a subscription at all', () => {
      expect(map('subscription.active', { nothing: 'useful' })).toBeNull();
      expect(map('subscription.active', null)).toBeNull();
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

    it('reports the provider ids the receiver falls back to', () => {
      expect(readProviderSubscriptionId('subscription.active', subscription())).toBe('sub_abc');
      expect(
        readProviderSubscriptionId('order.paid', { customerId: 'c', subscriptionId: 'sub_z' }),
      ).toBe('sub_z');
      expect(readProviderCustomerId(subscription())).toBe('cus_abc');
      expect(readProviderProductId(subscription())).toBe('prod_abc');
    });
  });
});
