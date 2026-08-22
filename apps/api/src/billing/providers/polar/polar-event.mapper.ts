import type { BillingEvent, ParsedWebhookEvent, SubscriptionStatus } from '@whatsappcrm/contracts';

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
 * Anything not listed is `ignored`, which the receiver records as processed: an
 * event we did not ask for is not an error, and answering non-2xx would make
 * Polar retry it ten times and then disable the endpoint. An event we *did* ask
 * for whose shape will not read is `unreadable` and is parked instead — see
 * `ParsedWebhookEvent`.
 *
 * ## Two spellings of every payload, and why (TAR-663)
 *
 * Polar's JSON is **snake_case** — `customer_id`, `current_period_start`,
 * `cancel_at_period_end`. The SDK's `Subscription` type is the camelCase object
 * its deserializer produces from that JSON, and the two reach this file by
 * different routes:
 *
 *   * a **webhook** arrives as raw bytes, is verified against the signature,
 *     stored in `webhook_events.payload` exactly as signed, and read back by the
 *     worker — so the mapper sees Polar's wire spelling, with timestamps still
 *     ISO strings;
 *   * a **read** (`getSubscription`, `resolveCheckout`) comes back through the
 *     SDK, already camelCased with `Date` values.
 *
 * Reading only the SDK spelling is what TAR-663 was: every real subscription
 * webhook failed `asSubscription`, mapped to nothing, and was recorded as
 * processed, so a tenant that completed checkout was never activated. The
 * readers below therefore accept **both** spellings and normalise to one shape,
 * which is also what keeps `getSubscription` comparable with what a webhook
 * would have written — the reconciliation job depends on that.
 */

/**
 * The subset of Polar's `Subscription` this integration reads, **normalised**:
 * camelCase names and `Date | string` instants, whichever spelling it arrived
 * in. Produced only by `asSubscription`.
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
  readonly seats: number | null;
  readonly currentPeriodStart: Date | string | null;
  readonly currentPeriodEnd: Date | string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly endsAt: Date | string | null;
  readonly startedAt: Date | string | null;
  readonly productId: string | null;
}

/** The subset of Polar's `Order` this integration reads, normalised the same way. */
export interface PolarOrderShape {
  readonly subscriptionId: string | null;
  readonly customerId: string;
  readonly subscription: {
    readonly currentPeriodStart: Date | string | null;
    readonly currentPeriodEnd: Date | string | null;
    readonly seats: number | null;
    readonly productId: string | null;
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
 * Translates a verified Polar payload into our vocabulary, or says why it did
 * not.
 *
 * `providerEventId` is the **`webhook-id` header**, passed in by the caller
 * rather than read from the body: Standard Webhooks names that header as the
 * idempotency key, and it exists whether or not Polar puts an id in the
 * envelope. `tenantId` is likewise resolved by the caller, which is the only
 * layer that can fall back to a `subscriptions` lookup.
 *
 * A subscribed event whose data will not read comes back `unreadable` rather
 * than as a quiet `ignored`, because those are the two ends of TAR-663: one is
 * an event nobody asked for, the other is a paying tenant not being activated.
 */
export function toBillingEvent(input: {
  envelope: PolarWebhookEnvelope;
  tenantId: string;
  providerEventId: string;
  receivedAt: Date;
}): ParsedWebhookEvent {
  const { envelope, tenantId, providerEventId, receivedAt } = input;
  const occurredAt = readTimestamp(envelope.timestamp) ?? receivedAt.toISOString();
  const context = { tenantId, providerEventId, occurredAt };

  switch (envelope.type) {
    case 'subscription.active':
      return subscriptionEvent('subscription.activated', envelope, context);

    case 'subscription.past_due':
      return subscriptionEvent('subscription.past_due', envelope, context);

    case 'subscription.revoked':
      // Access permanently terminated. This — and only this — is our cancellation.
      return subscriptionEvent('subscription.canceled', envelope, context);

    case 'subscription.canceled':
    case 'subscription.uncanceled':
      // A cancellation requested or withdrawn. Both write the banner columns and
      // neither moves the tenant: `cancelAtPeriodEnd` is read off the payload, so
      // one branch serves both.
      return subscriptionEvent('subscription.updated', envelope, context);

    case 'subscription.updated': {
      const subscription = asSubscription(envelope.data);

      if (subscription === null) {
        return unreadable(envelope);
      }

      // A status change *into* `past_due` on an update is a failed renewal that
      // Polar reported as an amendment rather than as its own event. It is
      // `payment.failed` rather than `subscription.past_due` because the cause is
      // the charge, and `lifecycle_events` records what moved the tenant.
      const type =
        SUBSCRIPTION_STATUS_BY_POLAR_STATUS[subscription.status] === 'past_due'
          ? 'payment.failed'
          : 'subscription.updated';

      return subscriptionEvent(type, { ...envelope, data: subscription }, context);
    }

    case 'order.paid': {
      const order = asOrder(envelope.data);

      if (order === null) {
        return unreadable(envelope);
      }

      if (order.subscriptionId === null) {
        // A one-off purchase. Nothing in this product sells one, and a payment
        // that is not for a subscription must not activate a tenant.
        return { outcome: 'ignored' };
      }

      return {
        outcome: 'event',
        event: {
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
        },
      };
    }

    default:
      return { outcome: 'ignored' };
  }
}

/** One subscribed subscription event: translated, or reported as unreadable. */
function subscriptionEvent(
  type: BillingEvent['type'],
  envelope: PolarWebhookEnvelope,
  context: { tenantId: string; providerEventId: string; occurredAt: string },
): ParsedWebhookEvent {
  const event = fromSubscription(type, envelope.data, context);

  return event === null ? unreadable(envelope) : { outcome: 'event', event };
}

/**
 * Why a subscribed payload would not read, in the words an operator needs.
 *
 * It names the event type and the identifying fields, because the failure this
 * exists for was a whole vocabulary being read under the wrong spelling — and
 * "could not parse payload" in `last_error` would have said nothing about that.
 */
function unreadable(envelope: PolarWebhookEnvelope): ParsedWebhookEvent {
  return {
    outcome: 'unreadable',
    detail:
      `${envelope.type} carries no readable id, status and customer id ` +
      `(keys: ${describeKeys(envelope.data)})`,
  };
}

/** The payload's own top-level keys, capped, so `last_error` stays one line. */
function describeKeys(data: unknown): string {
  if (typeof data !== 'object' || data === null) {
    return typeof data;
  }

  const keys = Object.keys(data);

  return keys.length <= MAX_REPORTED_KEYS
    ? keys.join(', ')
    : `${keys.slice(0, MAX_REPORTED_KEYS).join(', ')}, …`;
}

/** Enough keys to recognise the object, few enough to keep the line greppable. */
const MAX_REPORTED_KEYS = 12;

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
  return readString(data, 'customerId', 'customer_id');
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

  const { cancelAtPeriodEnd } = subscription;

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
  return readString(data, 'productId', 'product_id');
}

/**
 * A Polar subscription in either spelling, normalised — or `null` when the three
 * fields that identify one are not all there.
 *
 * Those three are the floor deliberately: everything else is optional on Polar's
 * side or optional to us, and refusing a payload for a missing `seats` would
 * park an event we could have applied.
 */
export function asSubscription(data: unknown): PolarSubscriptionShape | null {
  const id = readString(data, 'id');
  const status = readString(data, 'status');
  const customerId = readString(data, 'customerId', 'customer_id');

  if (id === null || status === null || customerId === null) {
    return null;
  }

  return {
    id,
    status,
    customerId,
    seats: readNumber(data, 'seats'),
    currentPeriodStart: readInstant(data, 'currentPeriodStart', 'current_period_start'),
    currentPeriodEnd: readInstant(data, 'currentPeriodEnd', 'current_period_end'),
    cancelAtPeriodEnd: readBoolean(data, 'cancelAtPeriodEnd', 'cancel_at_period_end'),
    endsAt: readInstant(data, 'endsAt', 'ends_at'),
    startedAt: readInstant(data, 'startedAt', 'started_at'),
    productId: readString(data, 'productId', 'product_id'),
  };
}

function asOrder(data: unknown): PolarOrderShape | null {
  const customerId = readString(data, 'customerId', 'customer_id');

  if (customerId === null) {
    return null;
  }

  const subscription = readField(data, 'subscription');

  return {
    subscriptionId: readString(data, 'subscriptionId', 'subscription_id'),
    customerId,
    subscription:
      typeof subscription === 'object' && subscription !== null
        ? {
            currentPeriodStart: readInstant(
              subscription,
              'currentPeriodStart',
              'current_period_start',
            ),
            currentPeriodEnd: readInstant(subscription, 'currentPeriodEnd', 'current_period_end'),
            seats: readNumber(subscription, 'seats'),
            productId: readString(subscription, 'productId', 'product_id'),
          }
        : null,
  };
}

/**
 * One field, under whichever name it arrived: the SDK's camelCase or Polar's
 * snake_case wire spelling. Names are tried in order, and `??` rather than `||`
 * so a legitimate `false` or `0` is not skipped for the next spelling.
 */
function readField(data: unknown, ...names: readonly string[]): unknown {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }

  const record = data as Record<string, unknown>;

  for (const name of names) {
    const value = record[name];

    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

/** A non-empty string, or `null`. An id that is not one is not an id. */
function readString(data: unknown, ...names: readonly string[]): string | null {
  const value = readField(data, ...names);

  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(data: unknown, ...names: readonly string[]): number | null {
  const value = readField(data, ...names);

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Absent, null or anything but a boolean reads as `false` — the safe direction. */
function readBoolean(data: unknown, ...names: readonly string[]): boolean {
  return readField(data, ...names) === true;
}

/** An instant as it arrived: a `Date` from the SDK, an ISO string off the wire. */
function readInstant(data: unknown, ...names: readonly string[]): Date | string | null {
  const value = readField(data, ...names);

  return value instanceof Date || typeof value === 'string' ? value : null;
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
