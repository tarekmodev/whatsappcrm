import type { BillingEvent, SubscriptionStatus } from '@whatsappcrm/contracts';

/**
 * Polar's vocabulary → ours. **The only file that knows what a Polar event is
 * called**, together with `polar-billing.provider.ts`.
 *
 * The whole point of `BillingEvent` is that nothing downstream — not the
 * subscription writer, not `TenantLifecycleService`, not the console — ever sees
 * a string from this table. Adding a second provider is a sibling of this file
 * and no edit anywhere else.
 *
 * ## The mapping, and the three entries worth reading twice
 *
 * **`subscription.canceled` is not our `canceled`.** Polar fires it when a
 * customer *requests* cancellation; the subscription is still paid through the
 * period end. `TENANT_STATUS_EFFECTS.cancelled` sets `apiAccess: false`, so
 * mapping it onto our cancellation would lock a tenant out of a period they have
 * already paid for, on the same day they clicked cancel. It therefore becomes a
 * plain `subscription.updated` carrying `cancelAtPeriodEnd: true`, which writes
 * the banner and no lifecycle transition.
 *
 * **`subscription.revoked` is our `subscription.canceled`.** Access ends when
 * the provider says access has ended — after dunning is exhausted, or on an
 * explicit revoke.
 *
 * **`subscription.created` is dropped.** A created subscription may not be
 * `active` yet; `subscription.active` is the activation signal, and acting on
 * both would activate a tenant whose first payment has not settled.
 *
 * ## What is deliberately not subscribed to
 *
 * `customer_seat.*` — we own seat identity and Polar bills a count (billing
 * contract, decision 1). `checkout.*` — `subscription.active` is authoritative,
 * and since TAR-651 removed the console's checkout-return call it is also the
 * only thing that writes a subscription, so nothing reads a checkout. `customer.*`,
 * `benefit*.*`, `product.*`, `refund.*`, `discount.*`, `organization.updated` —
 * none of them move a tenant or change what it may do.
 *
 * Anything not listed returns `null`, which the receiver records as processed:
 * an event we did not ask for is not an error, and answering non-2xx would make
 * Polar retry it ten times and then disable the endpoint.
 */

/**
 * The subset of Polar's `Subscription` this integration reads.
 *
 * Declared structurally rather than imported from the SDK so the mapper can be
 * unit-tested against a literal — the SDK's own type carries a `customer`, a
 * `product` and a price union that a test would have to fabricate in full to
 * assert one status mapping.
 */
export interface PolarSubscriptionShape {
  readonly id: string;
  readonly status: string;
  readonly customerId: string;
  readonly seats?: number | null;
  readonly currentPeriodStart?: Date | null;
  readonly currentPeriodEnd?: Date | null;
  readonly cancelAtPeriodEnd?: boolean;
  readonly endsAt?: Date | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly productId?: string | null;
}

/** The subset of Polar's `Order` this integration reads. */
export interface PolarOrderShape {
  readonly subscriptionId?: string | null;
  readonly customerId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly subscription?: {
    readonly id?: string;
    readonly currentPeriodStart?: Date | null;
    readonly currentPeriodEnd?: Date | null;
    readonly status?: string;
    readonly seats?: number | null;
    readonly productId?: string | null;
  } | null;
}

/** The envelope shape shared by every Polar webhook payload. */
export interface PolarWebhookEnvelope {
  readonly type: string;
  readonly timestamp?: Date | string;
  readonly data: unknown;
}

/**
 * Where a tenant id can be found on a Polar object, in the order the adapter
 * looks.
 *
 * Every checkout we open carries `metadata.tenant_id`, and Polar copies checkout
 * metadata onto the resulting order *and* subscription — so branch 1 covers the
 * overwhelming majority. The provider-id fallbacks are the caller's job, because
 * only it can read `subscriptions`.
 */
export const TENANT_ID_METADATA_KEY = 'tenant_id';

/**
 * Polar's subscription statuses → `SUBSCRIPTION_STATUSES`.
 *
 * Polar carries three we do not: `incomplete_expired`, `unpaid` and `paused`.
 * `incomplete_expired` is an `incomplete` that ran out of time, `unpaid` is a
 * `past_due` Polar has stopped retrying, and `paused` is a state we never enter
 * because nothing in the product pauses a subscription. Mapping each onto its
 * nearest neighbour is safe in the direction that matters — none of them widens
 * what a tenant may do — and leaves `SUBSCRIPTION_STATUSES` a provider-neutral
 * five rather than the union of every provider's vocabulary.
 */
const SUBSCRIPTION_STATUS_BY_POLAR_STATUS: Readonly<Record<string, SubscriptionStatus>> = {
  incomplete: 'incomplete',
  incomplete_expired: 'incomplete',
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  paused: 'canceled',
};

/**
 * The Polar event names this integration subscribes to, for the endpoint
 * configuration in the Polar dashboard and for the runbook.
 *
 * Exported so the docs and the dashboard cannot drift from the code silently —
 * this list is the answer to "which events should the endpoint be subscribed
 * to", and it lives beside the switch that handles them.
 */
export const SUBSCRIBED_POLAR_EVENTS = [
  'subscription.active',
  'subscription.updated',
  'subscription.uncanceled',
  'subscription.canceled',
  'subscription.past_due',
  'subscription.revoked',
  'order.paid',
] as const;

/**
 * Translates a verified Polar payload into our vocabulary, or `null` to ignore
 * it.
 *
 * `providerEventId` is the **`webhook-id` header**, passed in by the caller
 * rather than read from the body: Standard Webhooks names that header as the
 * idempotency key, and it exists whether or not Polar puts an id in the
 * envelope. `tenantId` is likewise resolved by the caller, which is the only
 * layer that can fall back to a `subscriptions` lookup.
 */
export function toBillingEvent(input: {
  envelope: PolarWebhookEnvelope;
  tenantId: string;
  providerEventId: string;
  receivedAt: Date;
}): BillingEvent | null {
  const { envelope, tenantId, providerEventId, receivedAt } = input;
  const occurredAt = readTimestamp(envelope.timestamp) ?? receivedAt.toISOString();

  switch (envelope.type) {
    case 'subscription.active':
      return fromSubscription('subscription.activated', envelope.data, {
        tenantId,
        providerEventId,
        occurredAt,
      });

    case 'subscription.past_due':
      return fromSubscription('subscription.past_due', envelope.data, {
        tenantId,
        providerEventId,
        occurredAt,
      });

    case 'subscription.revoked':
      // Access permanently terminated. This — and only this — is our cancellation.
      return fromSubscription('subscription.canceled', envelope.data, {
        tenantId,
        providerEventId,
        occurredAt,
      });

    case 'subscription.canceled':
    case 'subscription.uncanceled':
      // A cancellation requested or withdrawn. Both write the banner columns and
      // neither moves the tenant: `cancelAtPeriodEnd` is read off the payload, so
      // one branch serves both.
      return fromSubscription('subscription.updated', envelope.data, {
        tenantId,
        providerEventId,
        occurredAt,
      });

    case 'subscription.updated': {
      const subscription = asSubscription(envelope.data);

      if (subscription === null) {
        return null;
      }

      // A status change *into* `past_due` on an update is a failed renewal that
      // Polar reported as an amendment rather than as its own event. It is
      // `payment.failed` rather than `subscription.past_due` because the cause is
      // the charge, and `lifecycle_events` records what moved the tenant.
      const type =
        SUBSCRIPTION_STATUS_BY_POLAR_STATUS[subscription.status] === 'past_due'
          ? 'payment.failed'
          : 'subscription.updated';

      return fromSubscription(type, subscription, { tenantId, providerEventId, occurredAt });
    }

    case 'order.paid': {
      const order = asOrder(envelope.data);

      if (order === null || !order.subscriptionId) {
        // A one-off purchase. Nothing in this product sells one, and a payment
        // that is not for a subscription must not activate a tenant.
        return null;
      }

      return {
        type: 'payment.succeeded',
        tenantId,
        providerEventId,
        // The order does not restate the plan; the subscription it belongs to
        // does, and the next `subscription.updated` carries it. Leaving these
        // null is what stops a renewal receipt overwriting a plan with nothing.
        planKey: null,
        seats: order.subscription?.seats ?? null,
        status: 'active',
        currentPeriodStart: toIsoOrNull(order.subscription?.currentPeriodStart),
        currentPeriodEnd: toIsoOrNull(order.subscription?.currentPeriodEnd),
        occurredAt,
        providerSubscriptionId: order.subscriptionId,
        providerCustomerId: order.customerId,
      };
    }

    default:
      return null;
  }
}

/**
 * The tenant id Polar carries for us, or `null` when the object predates the
 * metadata we set at checkout.
 *
 * Read defensively: `metadata` values are `string | number | boolean` on Polar's
 * side, and a tenant id that arrived as anything but a string is not one we can
 * use to scope a write.
 */
export function readTenantIdFromMetadata(data: unknown): string | null {
  const metadata = (data as { metadata?: unknown } | null)?.metadata;

  if (typeof metadata !== 'object' || metadata === null) {
    return null;
  }

  const value = (metadata as Record<string, unknown>)[TENANT_ID_METADATA_KEY];

  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The provider subscription id an event names, for the caller's fallback lookup. */
export function readProviderSubscriptionId(type: string, data: unknown): string | null {
  if (type === 'order.paid') {
    return asOrder(data)?.subscriptionId ?? null;
  }

  return asSubscription(data)?.id ?? null;
}

/** The provider customer id an event names, for the caller's second fallback. */
export function readProviderCustomerId(data: unknown): string | null {
  const customerId = (data as { customerId?: unknown } | null)?.customerId;

  return typeof customerId === 'string' && customerId.length > 0 ? customerId : null;
}

/**
 * A Polar subscription in our vocabulary, used by the webhook mapper and by
 * `getSubscription` / `resolveCheckout` alike — the reconciliation job has to
 * compare exactly what a webhook would have written, or it would "correct"
 * every row it read.
 *
 * `planKey` is **not** derived here. Polar knows a product id; the mapping from
 * product to plan lives in `plans.provider_product_id`, which is a database read
 * the caller owns. The product id travels as `providerProductId` on the return
 * instead, and the caller resolves it.
 */
export function fromSubscription(
  type: BillingEvent['type'],
  data: unknown,
  context: { tenantId: string; providerEventId: string; occurredAt: string },
): BillingEvent | null {
  const subscription = asSubscription(data);

  if (subscription === null) {
    return null;
  }

  const cancelAtPeriodEnd = subscription.cancelAtPeriodEnd ?? false;

  return {
    type,
    tenantId: context.tenantId,
    providerEventId: context.providerEventId,
    // Resolved from `productId` by the caller, which is the only layer that can
    // read the catalogue. Null here means "this event says nothing new about the
    // plan", and the writer leaves the column alone.
    planKey: null,
    seats: subscription.seats ?? null,
    status: SUBSCRIPTION_STATUS_BY_POLAR_STATUS[subscription.status] ?? null,
    currentPeriodStart: toIsoOrNull(subscription.currentPeriodStart),
    currentPeriodEnd: toIsoOrNull(subscription.currentPeriodEnd),
    occurredAt: context.occurredAt,
    cancelAtPeriodEnd,
    // `endsAt` is when a requested cancellation takes effect. Cleared when the
    // cancellation is withdrawn, so the console's banner disappears with it.
    cancelsAt: cancelAtPeriodEnd ? toIsoOrNull(subscription.endsAt) : null,
    providerSubscriptionId: subscription.id,
    providerCustomerId: subscription.customerId,
  };
}

/** The Polar product id an event names, so the caller can resolve it to a plan. */
export function readProviderProductId(data: unknown): string | null {
  const productId = (data as { productId?: unknown } | null)?.productId;

  return typeof productId === 'string' && productId.length > 0 ? productId : null;
}

function asSubscription(data: unknown): PolarSubscriptionShape | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const candidate = data as Partial<PolarSubscriptionShape>;

  return typeof candidate.id === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.customerId === 'string'
    ? (candidate as PolarSubscriptionShape)
    : null;
}

function asOrder(data: unknown): PolarOrderShape | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const candidate = data as Partial<PolarOrderShape>;

  return typeof candidate.customerId === 'string' ? (candidate as PolarOrderShape) : null;
}

/**
 * Polar's envelope timestamp, as an ISO instant.
 *
 * The SDK parses it to a `Date`; a payload read back out of `webhook_events`
 * carries the JSON string instead, and the sweeper's replay path is exactly that
 * case. Both are accepted, and an unparseable one falls back to receipt time —
 * an event whose order we cannot establish is treated as having arrived now,
 * which is the conservative direction for the `last_event_at` guard.
 */
function readTimestamp(value: Date | string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
