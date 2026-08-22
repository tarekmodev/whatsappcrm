import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Polar } from '@polar-sh/sdk';
import { SDKValidationError } from '@polar-sh/sdk/models/errors/sdkvalidationerror.js';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks.js';
import type {
  BillingEvent,
  BillingProvider,
  HostedSession,
  ParsedWebhookEvent,
  WebhookSubject,
} from '@whatsappcrm/contracts';
import { describeFailure } from '../../../common/describe-failure';
import { BillingProviderUnavailableError } from '../../billing.errors';
import {
  asSubscription,
  fromSubscription,
  readProviderCustomerId,
  readProviderProductId,
  readProviderSubscriptionId,
  readTenantIdFromMetadata,
  toBillingEvent,
  TENANT_ID_METADATA_KEY,
  type PolarSubscriptionShape,
} from './polar-event.mapper';

/**
 * Standard Webhooks' three headers, lower-cased because Express lower-cases
 * every header name it indexes.
 */
const WEBHOOK_ID_HEADER = 'webhook-id';
const WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp';
const WEBHOOK_SIGNATURE_HEADER = 'webhook-signature';

/**
 * How Polar prorates a mid-cycle seat change. `prorate` bills the difference now
 * rather than at the next invoice, which is what a per-seat plan should do: a
 * tenant that adds five agents on day two has five more agents from day two.
 */
const SEAT_PRORATION_BEHAVIOR = 'prorate';

/**
 * The Polar.sh adapter — **the only class outside `polar-event.mapper.ts` that
 * knows Polar exists**, and the whole reason `BillingProvider` is a port.
 *
 * ## Every tenant is a Polar customer keyed by its own id
 *
 * Checkout sets `externalCustomerId` to the tenant id and `metadata.tenant_id`
 * alongside it. That single decision is what makes every other method here
 * answerable from `tenantId` alone — `subscriptions.list({ externalCustomerId })`
 * finds the subscription, `customerSessions.create({ externalCustomerId })` opens
 * the portal — so the adapter never needs to read our database to find its own
 * objects, and the port stays expressed in our vocabulary rather than Polar's.
 *
 * `metadata.tenant_id` is belt and braces on top of it: Polar copies checkout
 * metadata onto the resulting order and subscription, so a webhook arrives
 * already naming its tenant and the receiver's fallback lookups are the
 * exception rather than the path.
 *
 * ## Sandbox is a configuration value, and the default
 *
 * `POLAR_ENVIRONMENT` selects the server; absent means `sandbox`, because the
 * failure direction of a missing value has to be "no live charges". Sandbox and
 * production tokens are separate and not interchangeable at Polar, so a token
 * from the wrong estate fails there rather than charging a real customer here.
 *
 * ## Failure shape
 *
 * Every call is bounded by `POLAR_REQUEST_TIMEOUT_MS` and every failure becomes
 * `BillingProviderUnavailableError`, which the route renders as
 * `upstream_unavailable`. Nothing here writes tenant state: an outage means a
 * checkout that does not open, never a subscription that half-applies.
 */
@Injectable()
export class PolarBillingProvider implements BillingProvider {
  private readonly logger = new Logger(PolarBillingProvider.name);
  private readonly polar: Polar;
  private readonly webhookSecret: string | undefined;

  constructor(config: ConfigService) {
    this.webhookSecret = config.get<string>('POLAR_WEBHOOK_SECRET');

    this.polar = new Polar({
      accessToken: config.get<string>('POLAR_ACCESS_TOKEN'),
      server: config.getOrThrow<'sandbox' | 'production'>('POLAR_ENVIRONMENT'),
      timeoutMs: config.getOrThrow<number>('POLAR_REQUEST_TIMEOUT_MS'),
      // One retry, and only on the classes that are worth retrying. A checkout
      // create is not idempotent at Polar, so retrying a 4xx would risk two
      // sessions for one click; a 5xx or a 429 has not been accepted at all.
      retryConfig: {
        strategy: 'backoff',
        backoff: { initialInterval: 250, maxInterval: 1_000, exponent: 2, maxElapsedTime: 3_000 },
        retryConnectionErrors: true,
      },
    });
  }

  async createCheckout(input: {
    tenantId: string;
    planKey: string;
    seats: number;
    successUrl: string;
    cancelUrl: string;
    providerProductId: string | null;
  }): Promise<HostedSession> {
    if (input.providerProductId === null) {
      // The plan exists in our catalogue but has never been mapped to a Polar
      // product. Refusing here is the difference between a retryable
      // `upstream_unavailable` and a 422 from Polar that reads like an outage.
      throw new BillingProviderUnavailableError(
        `plan ${input.planKey} has no provider_product_id; seed it before enabling checkout`,
      );
    }

    return await this.call('createCheckout', async () => {
      const checkout = await this.polar.checkouts.create({
        products: [input.providerProductId as string],
        seats: input.seats,
        // Both, deliberately: the external id is how every later call finds this
        // customer without a database read, and the metadata is how a webhook
        // names its tenant without a lookup at all.
        externalCustomerId: input.tenantId,
        metadata: { [TENANT_ID_METADATA_KEY]: input.tenantId, plan_key: input.planKey },
        successUrl: input.successUrl,
      });

      return { url: checkout.url, expiresAt: checkout.expiresAt.toISOString() };
    });
  }

  /**
   * A Polar-hosted portal session for invoices, payment method, plan change and
   * cancellation.
   *
   * Sessions are short-lived and free to create, so one is generated on every
   * click and **never stored**: a cached portal URL is a live credential for
   * somebody's billing account sitting in a database column.
   */
  async createPortalSession(input: {
    tenantId: string;
    returnUrl: string;
  }): Promise<HostedSession> {
    return await this.call('createPortalSession', async () => {
      const session = await this.polar.customerSessions.create({
        externalCustomerId: input.tenantId,
        returnUrl: input.returnUrl,
      });

      return { url: session.customerPortalUrl, expiresAt: session.expiresAt.toISOString() };
    });
  }

  /** Re-reads the provider's truth. The reconciliation job's only source. */
  async getSubscription(input: { tenantId: string }): Promise<BillingEvent | null> {
    return await this.call('getSubscription', async () => {
      const subscription = await this.currentSubscription(input.tenantId);

      if (subscription === null) {
        return null;
      }

      return this.asEvent(subscription, input.tenantId, `reconcile-${subscription.id}`);
    });
  }

  async updateSeats(input: { tenantId: string; seats: number }): Promise<void> {
    await this.call('updateSeats', async () => {
      const subscription = await this.currentSubscription(input.tenantId);

      if (subscription === null) {
        // Nothing to meter against. A trialing tenant has no Polar subscription
        // and its seat count is enforced from `tenant_entitlements` alone, so
        // this is the ordinary case rather than a failure.
        return;
      }

      if (subscription.seats === input.seats) {
        // The counts already agree. Skipping the write keeps the reconciliation
        // job's log honest — every line it emits is a correction it made.
        return;
      }

      await this.polar.subscriptions.update({
        id: subscription.id,
        subscriptionUpdate: {
          seats: input.seats,
          prorationBehavior: SEAT_PRORATION_BEHAVIOR,
        },
      });
    });
  }

  async cancelSubscription(input: { tenantId: string; atPeriodEnd: boolean }): Promise<void> {
    await this.call('cancelSubscription', async () => {
      const subscription = await this.currentSubscription(input.tenantId);

      if (subscription === null) {
        return;
      }

      await this.polar.subscriptions.update({
        id: subscription.id,
        // `revoke` ends access now; `cancelAtPeriodEnd` leaves the tenant
        // serviceable through a period it has already paid for. The two are
        // different products, not two spellings of one.
        subscriptionUpdate: input.atPeriodEnd ? { cancelAtPeriodEnd: true } : { revoke: true },
      });
    });
  }

  async changePlan(input: {
    tenantId: string;
    planKey: string;
    seats: number;
    providerProductId: string | null;
  }): Promise<void> {
    if (input.providerProductId === null) {
      throw new BillingProviderUnavailableError(
        `plan ${input.planKey} has no provider_product_id; seed it before enabling plan changes`,
      );
    }

    await this.call('changePlan', async () => {
      const subscription = await this.currentSubscription(input.tenantId);

      if (subscription === null) {
        // No subscription to amend. The caller's answer is checkout, and it
        // decides that from `subscriptions` rather than from an exception here.
        return;
      }

      await this.polar.subscriptions.update({
        id: subscription.id,
        subscriptionUpdate: {
          productId: input.providerProductId,
          prorationBehavior: SEAT_PRORATION_BEHAVIOR,
        },
      });
    });
  }

  /**
   * Standard Webhooks verification over the **exact bytes** Polar signed.
   *
   * Delegated to Polar's own helper rather than hand-rolled. We already
   * hand-rolled Meta's HMAC in `whatsapp-signature.ts` and it was correct, but
   * Meta's scheme is one line: Standard Webhooks is a multi-signature,
   * base64-secret, timestamp-toleranced scheme where a subtle mistake fails
   * *open*, and the library is Polar's own and versioned with the SDK.
   *
   * Returns `false` rather than throwing, so the controller owns the response.
   * An absent secret is a refusal, not a bypass: an environment that was never
   * given one must not accept unsigned payloads.
   *
   * ⚠️ `validateEvent` does two things, and only the first is this method's
   * question: it verifies the signature and then parses the body against the
   * event schemas pinned in this SDK version. A failure of the second is an
   * authentic delivery this SDK cannot type, and it is accepted — see the catch
   * below for why rethrowing it was a liability rather than a safeguard.
   */
  verifyWebhookSignature(
    rawBody: Uint8Array,
    headers: Record<string, string | undefined>,
  ): boolean {
    if (this.webhookSecret === undefined) {
      this.logger.error(
        'POLAR_WEBHOOK_SECRET is not configured: every billing webhook is being refused.',
      );

      return false;
    }

    const signatureHeaders: Record<string, string> = {};

    for (const name of [WEBHOOK_ID_HEADER, WEBHOOK_TIMESTAMP_HEADER, WEBHOOK_SIGNATURE_HEADER]) {
      const value = headers[name];

      if (value === undefined) {
        return false;
      }

      signatureHeaders[name] = value;
    }

    try {
      validateEvent(Buffer.from(rawBody), signatureHeaders, this.webhookSecret);

      return true;
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        // The reason stays in the log. To the caller a bad signature and a
        // secret we were never given are one refusal, because the difference is
        // a reconnaissance signal for whoever is probing the endpoint.
        this.logger.warn(`Billing webhook signature rejected: ${error.message}`);

        return false;
      }

      if (error instanceof SDKValidationError) {
        // **Verified, then rejected by the SDK's own model of the event.**
        // `validateEvent` checks the signature and *then* parses the body
        // against the schemas pinned in this SDK version, so this branch is
        // reached only after the bytes have been proved authentic — a Polar
        // event type newer than the pinned SDK, or a field it does not model
        // yet, lands here.
        //
        // Accepting it is the whole point: rethrowing made an authentic
        // delivery a 500, and ten non-2xx responses in a row disable the
        // endpoint at Polar. The payload is stored instead, and our own mapper
        // decides whether it is an event, ignorable, or unreadable and parked.
        this.logger.warn(
          `Billing webhook verified but not typed by the pinned Polar SDK: ${describeFailure(error)}. ` +
            'Stored for the mapper to decide; upgrade @polar-sh/sdk if this persists.',
        );

        return true;
      }

      throw error;
    }
  }

  readWebhookSubject(payload: unknown): WebhookSubject {
    const envelope = payload as { type?: unknown; data?: unknown };
    const type = typeof envelope.type === 'string' ? envelope.type : '';

    return {
      tenantId: readTenantIdFromMetadata(envelope.data),
      providerSubscriptionId: readProviderSubscriptionId(type, envelope.data),
      providerCustomerId: readProviderCustomerId(envelope.data),
      // The empty string the fallback above produces is not a type; an operator
      // reading a park alert needs "no type on the envelope" to be visibly
      // different from a type we simply do not handle.
      eventType: type === '' ? null : type,
    };
  }

  /**
   * The stored payload in our vocabulary, or why it is not.
   *
   * An envelope with no `type` is `unreadable` rather than `ignored`: every
   * Polar delivery carries one, so a payload without it is a row that needs
   * looking at, not a subscription we did not ask for.
   */
  parseWebhookEvent(
    payload: unknown,
    headers: Record<string, string | undefined>,
    tenantId: string,
  ): ParsedWebhookEvent {
    const providerEventId = headers[WEBHOOK_ID_HEADER];
    const envelope = payload as { type?: unknown; data?: unknown };

    if (providerEventId === undefined) {
      return { outcome: 'unreadable', detail: `no ${WEBHOOK_ID_HEADER} to key the event on` };
    }

    if (typeof envelope.type !== 'string') {
      return { outcome: 'unreadable', detail: 'payload carries no event type' };
    }

    const parsed = toBillingEvent({
      envelope: {
        type: envelope.type,
        data: envelope.data,
        timestamp: readEnvelopeTimestamp(payload),
      },
      tenantId,
      providerEventId,
      receivedAt: new Date(),
    });

    if (parsed.outcome !== 'event') {
      return parsed;
    }

    return {
      outcome: 'event',
      event: {
        ...parsed.event,
        providerProductId: readProviderProductId(envelope.data) ?? undefined,
      },
    };
  }

  /**
   * The plan and seats a completed checkout actually bought, so the console
   * reflects the purchase on return rather than waiting on a webhook that lands
   * seconds later.
   *
   * `null` while the session is still open. Not a substitute for the webhook —
   * that one is authoritative — and both are made safe to apply in either order
   * by `subscriptions.last_event_at`.
   */
  async resolveCheckout(input: {
    tenantId: string;
    checkoutId: string;
  }): Promise<BillingEvent | null> {
    return await this.call('resolveCheckout', async () => {
      const checkout = await this.polar.checkouts.get({ id: input.checkoutId });

      if (checkout.status !== 'succeeded' || checkout.subscriptionId === null) {
        return null;
      }

      // The checkout carries a subscription id but not the subscription; the
      // period bounds and the seat count are on the subscription, and writing a
      // row without them would leave `UsagePeriodResolver` with no window.
      const subscription = await this.polar.subscriptions.get({ id: checkout.subscriptionId });

      return this.asEvent(subscription, input.tenantId, `checkout-${input.checkoutId}`);
    });
  }

  /**
   * This tenant's Polar subscription, found by the external customer id checkout
   * set — never by anything the caller supplied.
   *
   * Bounded to one page and filtered to the active ones. A tenant has at most
   * one live subscription in this product; if Polar ever reports two, the newest
   * wins and the log says so, because silently picking the first would make
   * which one we bill against depend on Polar's default ordering.
   */
  private async currentSubscription(tenantId: string): Promise<PolarSubscriptionShape | null> {
    const page = await this.polar.subscriptions.list({
      externalCustomerId: tenantId,
      active: true,
      limit: 10,
    });

    // Normalised through the mapper's reader rather than cast: the SDK's own
    // camelCase shape is only one of the two spellings that reader accepts, and
    // going through it is what keeps a read comparable with what a webhook for
    // the same subscription would have written (TAR-663).
    const items = (page.result?.items ?? [])
      .map((item) => asSubscription(item))
      .filter((item): item is PolarSubscriptionShape => item !== null);

    if (items.length === 0) {
      return null;
    }

    if (items.length > 1) {
      this.logger.warn(
        `Tenant ${tenantId} has ${items.length} active subscriptions at the provider; ` +
          'using the most recently started one. This needs an operator to reconcile.',
      );
    }

    return items.reduce((newest, candidate) =>
      startedAtOf(candidate) > startedAtOf(newest) ? candidate : newest,
    );
  }

  /**
   * A subscription read (not a webhook) as a normalised event.
   *
   * `providerEventId` is synthesised and prefixed by its source, because these
   * do not come from a delivery and there is no `webhook-id` to key on. Nothing
   * dedupes on it — the receiver's replay defence is `webhook_events`, which
   * these paths do not write — but `lifecycle_events.metadata` records it, and
   * `reconcile-…` in that column is what tells an operator the transition came
   * from the nightly job rather than from Polar.
   */
  private asEvent(
    subscription: unknown,
    tenantId: string,
    providerEventId: string,
  ): BillingEvent | null {
    const event = fromSubscription('subscription.updated', subscription, {
      tenantId,
      providerEventId,
      occurredAt: new Date().toISOString(),
    });

    if (event === null) {
      return null;
    }

    return {
      ...event,
      // An active subscription read back is an activation as far as the
      // lifecycle is concerned: it is what moves a tenant whose webhook was
      // missed out of `past_due`.
      type: event.status === 'active' ? 'subscription.activated' : event.type,
      providerProductId: readProviderProductId(subscription) ?? undefined,
    };
  }

  /**
   * Wraps one provider call: bounded, logged, and translated into the one error
   * the routes above know how to render.
   *
   * Every failure is `upstream_unavailable` and none of them changes tenant
   * state. The detail — status code, Polar's message — goes to the log with the
   * operation name; the caller gets a sentence a tenant admin can read.
   */
  private async call<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      const detail = describeFailure(error);

      // `describeFailure` for the label — it is deliberately message-free, and
      // this string is what the thrown error carries. The stack goes to the
      // server log beside it, which is where a status code and Polar's own
      // wording belong and where a tenant admin never looks.
      this.logger.error(
        `Polar ${operation} failed: ${detail}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new BillingProviderUnavailableError(`${operation}: ${detail}`);
    }
  }
}

/** Newest-first ordering key. A subscription with no readable start sorts oldest. */
function startedAtOf(subscription: PolarSubscriptionShape): number {
  const { startedAt } = subscription;

  if (startedAt === null) {
    return 0;
  }

  const parsed = startedAt instanceof Date ? startedAt : new Date(startedAt);

  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

/**
 * The envelope's own timestamp, whether the payload came straight from the SDK
 * (a `Date`) or back out of `webhook_events.payload` (an ISO string).
 *
 * The sweeper's replay path is exactly the second case, and an event whose
 * timestamp did not survive the round trip would compare as "now" against
 * `last_event_at` and defeat the out-of-order guard.
 */
function readEnvelopeTimestamp(payload: unknown): Date | string | undefined {
  const timestamp = (payload as { timestamp?: unknown } | null)?.timestamp;

  return timestamp instanceof Date || typeof timestamp === 'string' ? timestamp : undefined;
}
