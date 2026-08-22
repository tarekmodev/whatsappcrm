import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BillingEvent,
  BillingProvider,
  HostedSession,
  ParsedWebhookEvent,
  WebhookSubject,
} from '@whatsappcrm/contracts';

/** How long a fake checkout session stays resolvable. Long enough to click through. */
const SESSION_LIFETIME_MS = 30 * 60 * 1_000;

/** A fake period, so `UsagePeriodResolver` has real bounds to key counters on. */
const PERIOD_LENGTH_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Where `FakeCheckoutController` serves the stand-in hosted page, relative to the
 * global `api` prefix `bootstrap.ts` sets.
 *
 * Declared here rather than in the controller because this adapter is what puts
 * the URL in front of a browser: one string builds the link and mounts the route,
 * so the two cannot drift into a 404 that reads as a broken checkout.
 */
export const FAKE_CHECKOUT_ROUTE_PATH = 'billing/fake-checkout';

/** The global prefix, so the link this adapter hands out is the path Nest mounts. */
const API_PREFIX = 'api';

/** What the shopper did on the stand-in hosted page. */
export type FakeCheckoutOutcome = 'paid' | 'cancelled';

/** What the stand-in hosted page needs in order to behave like a real one. */
export interface FakeCheckoutSettlement {
  /**
   * Where to send the browser. Taken from the session this adapter stored when
   * the checkout was opened, never from the request — a redirect target a caller
   * can choose is an open redirect.
   */
  readonly redirectTo: string;

  /**
   * The activation to deliver as a webhook, or `null` when the shopper backed
   * out. The delivery is the page's job, not this adapter's: a provider does not
   * call itself back.
   */
  readonly event: BillingEvent | null;
}

/**
 * The local and test adapter — what lets the whole billing flow be exercised
 * with no Polar account, no network and no credentials.
 *
 * **This is not a stub that returns constants.** It keeps enough state to make
 * the flow real: a checkout it opened can be resolved into an activated
 * subscription with the plan and seats that were asked for, seats can be
 * updated, a cancellation sets `cancelAtPeriodEnd`, and the same subscription
 * comes back from `getSubscription` afterwards. That is the difference between a
 * fake that proves the wiring works and one that only proves the code compiles.
 *
 * It is bound outside production by `BILLING_PROVIDER_DRIVER`, which defaults to
 * `fake` — an environment that was never given Polar credentials runs the whole
 * flow rather than failing at the first request.
 *
 * ## It has a hosted page, because a provider that cannot call back has nothing
 *
 * The one thing a fake payment provider cannot do is deliver its own webhook:
 * there is no external system to send it. Polar's part of the flow is a page the
 * shopper lands on, pays on, and is redirected away from — and the delivery is
 * made *because* of what happened on that page. So the fake has one too:
 * `createCheckout` points the browser at `FakeCheckoutController`, and settling
 * there produces the activation event that the controller delivers through the
 * ordinary webhook path (TAR-658).
 *
 * That keeps the real invariant intact rather than working around it. The webhook
 * is still the only writer of a subscription — TAR-651's point — and the fake
 * driver still rehearses signature verification, replay absorption, the queue and
 * `SubscriptionSyncService` rather than shortcutting past all four.
 *
 * ## What it does not pretend to be
 *
 * State is in process memory, so a restart forgets every subscription and two
 * replicas disagree. That is correct for its purpose and would be a data-loss
 * bug in production, which is why the production binding is
 * `PolarBillingProvider` and why nothing here reads or writes the database — the
 * durable record is `subscriptions`, written by `SubscriptionSyncService` from
 * the events this returns.
 *
 * ## Webhook signing
 *
 * It signs and verifies with an HMAC over the raw body under a per-process key,
 * so a test can produce a delivery this adapter accepts without knowing a
 * secret, and a *forged* one is still refused. Verification that returned `true`
 * unconditionally would make the receiver's most important test — that an
 * unsigned payload is rejected — pass against nothing.
 */
@Injectable()
export class FakeBillingProvider implements BillingProvider {
  private readonly logger = new Logger(FakeBillingProvider.name);
  private readonly checkouts = new Map<string, FakeCheckout>();
  private readonly subscriptions = new Map<string, FakeSubscription>();
  private readonly signingKey = randomUUID();
  private readonly consoleOrigin: string;

  constructor(config: ConfigService) {
    // The base a relative return URL is resolved against, so a caller that passes
    // a path rather than an absolute URL still gets a link that opens.
    this.consoleOrigin = config.getOrThrow<string>('WEB_ORIGIN');

    this.logger.warn(
      'Billing is running on the fake provider: no checkout is real and no money moves. ' +
        'Set BILLING_PROVIDER_DRIVER=polar with credentials to use the real rail.',
    );
  }

  createCheckout(input: {
    tenantId: string;
    planKey: string;
    seats: number;
    successUrl: string;
    cancelUrl: string;
    providerProductId: string | null;
  }): Promise<HostedSession> {
    const checkoutId = randomUUID();
    const successUrl = new URL(input.successUrl, this.consoleOrigin);
    const cancelUrl = new URL(input.cancelUrl, this.consoleOrigin);

    this.checkouts.set(checkoutId, {
      tenantId: input.tenantId,
      planKey: input.planKey,
      seats: input.seats,
      // Held here, so settling reads them from the session rather than from
      // whoever opens the page.
      successUrl: successUrl.toString(),
      cancelUrl: cancelUrl.toString(),
    });

    // The stand-in hosted page, on the same host the shopper is already on: the
    // console proxies `/api/*` to this API (`next.config.mjs`), so the whole flow
    // — open, settle, return — stays on the tenant's own origin exactly as it
    // does against Polar.
    const page = new URL(`/${API_PREFIX}/${FAKE_CHECKOUT_ROUTE_PATH}/${checkoutId}`, successUrl);

    return Promise.resolve({
      url: page.toString(),
      expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS).toISOString(),
    });
  }

  /**
   * What the stand-in hosted page did: the browser's next stop, and the delivery
   * that has to follow a payment.
   *
   * **Not keyed on a tenant, deliberately.** A real hosted checkout page carries
   * no session from our application — the shopper may not even be signed in by
   * the time they pay — and it is the unguessable session id in the URL that
   * stands in for a credential. This mirrors that rather than inventing an
   * authenticated variant the real flow does not have. `resolveCheckout` below is
   * the tenant-scoped read, and it keeps its tenant check.
   *
   * `null` for a session that was never opened, which the page answers as a 404.
   */
  settleHostedCheckout(
    checkoutId: string,
    outcome: FakeCheckoutOutcome,
  ): FakeCheckoutSettlement | null {
    const checkout = this.checkouts.get(checkoutId);

    if (checkout === undefined) {
      return null;
    }

    if (outcome === 'cancelled') {
      // Nothing was bought, so there is nothing to deliver — the console reads
      // the outcome off the return URL it composed when it opened the session.
      return { redirectTo: checkout.cancelUrl, event: null };
    }

    return { redirectTo: checkout.successUrl, event: this.activate(checkoutId, checkout) };
  }

  createPortalSession(input: { tenantId: string; returnUrl: string }): Promise<HostedSession> {
    const url = new URL(input.returnUrl, this.consoleOrigin);

    url.searchParams.set('fake_portal', '1');

    return Promise.resolve({ url: url.toString(), expiresAt: null });
  }

  getSubscription(input: { tenantId: string }): Promise<BillingEvent | null> {
    const subscription = this.subscriptions.get(input.tenantId);

    return Promise.resolve(
      subscription === undefined
        ? null
        : this.toEvent(subscription, 'subscription.updated', `fake-read-${randomUUID()}`),
    );
  }

  updateSeats(input: { tenantId: string; seats: number }): Promise<void> {
    const subscription = this.subscriptions.get(input.tenantId);

    if (subscription !== undefined) {
      subscription.seats = input.seats;
    }

    return Promise.resolve();
  }

  cancelSubscription(input: { tenantId: string; atPeriodEnd: boolean }): Promise<void> {
    const subscription = this.subscriptions.get(input.tenantId);

    if (subscription === undefined) {
      return Promise.resolve();
    }

    if (input.atPeriodEnd) {
      subscription.cancelAtPeriodEnd = true;
    } else {
      subscription.status = 'canceled';
      subscription.cancelAtPeriodEnd = false;
    }

    return Promise.resolve();
  }

  changePlan(input: {
    tenantId: string;
    planKey: string;
    seats: number;
    providerProductId: string | null;
  }): Promise<void> {
    const subscription = this.subscriptions.get(input.tenantId);

    if (subscription !== undefined) {
      subscription.planKey = input.planKey;
      subscription.seats = input.seats;
    }

    return Promise.resolve();
  }

  /**
   * A real HMAC over the raw body, under a key this process generated at boot.
   *
   * `sign()` is the matching half, which is what lets an integration test post a
   * delivery this accepts. A forged body still fails, so the receiver's
   * refusal path is genuinely covered rather than trivially satisfied.
   */
  verifyWebhookSignature(
    rawBody: Uint8Array,
    headers: Record<string, string | undefined>,
  ): boolean {
    const presented = headers['webhook-signature'];

    if (presented === undefined) {
      return false;
    }

    const expected = this.sign(Buffer.from(rawBody));
    const presentedBytes = Buffer.from(presented, 'utf8');
    const expectedBytes = Buffer.from(expected, 'utf8');

    // Length-checked before the comparison: `timingSafeEqual` throws on a length
    // mismatch, and a throw here would become a 500 on a public route.
    return (
      presentedBytes.length === expectedBytes.length &&
      timingSafeEqual(presentedBytes, expectedBytes)
    );
  }

  /** The signature a test attaches to a body so this adapter accepts it. */
  sign(rawBody: Buffer): string {
    return `v1,${createHmac('sha256', this.signingKey).update(rawBody).digest('base64')}`;
  }

  readWebhookSubject(payload: unknown): WebhookSubject {
    const envelope = payload as { type?: unknown; data?: { tenantId?: unknown } } | null;
    const tenantId = envelope?.data?.tenantId;

    return {
      tenantId: typeof tenantId === 'string' ? tenantId : null,
      // The fake speaks our vocabulary, so there is nothing opaque to fall back
      // to and no provider-side row to look up.
      providerSubscriptionId: null,
      providerCustomerId: null,
      eventType: typeof envelope?.type === 'string' ? envelope.type : null,
    };
  }

  /**
   * The fake's envelope is `{ type, data: BillingEvent }` — our own vocabulary,
   * because there is no provider vocabulary to translate from. It exists so the
   * receiver, the worker and the lifecycle producer can all be driven end to end
   * without a Polar payload fixture.
   */
  parseWebhookEvent(
    payload: unknown,
    headers: Record<string, string | undefined>,
    tenantId: string,
  ): ParsedWebhookEvent {
    const providerEventId = headers['webhook-id'];
    const envelope = payload as { data?: unknown } | null;

    if (providerEventId === undefined) {
      return { outcome: 'unreadable', detail: 'no webhook-id to key the event on' };
    }

    if (typeof envelope?.data !== 'object' || envelope.data === null) {
      // Every envelope this adapter emits carries a `data` object, so one that
      // does not is a payload worth parking rather than an event to skip.
      return { outcome: 'unreadable', detail: 'envelope carries no data object' };
    }

    return {
      outcome: 'event',
      event: { ...(envelope.data as BillingEvent), tenantId, providerEventId },
    };
  }

  resolveCheckout(input: { tenantId: string; checkoutId: string }): Promise<BillingEvent | null> {
    const checkout = this.checkouts.get(input.checkoutId);

    if (checkout === undefined || checkout.tenantId !== input.tenantId) {
      // Either the session never existed or it belongs to another tenant. Both
      // answer `null` — a checkout id is guessable, and confirming that one
      // exists for somebody else is a cross-tenant disclosure however small.
      return Promise.resolve(null);
    }

    return Promise.resolve(this.activate(input.checkoutId, checkout));
  }

  /**
   * Turns an opened checkout into the subscription it bought, and reports it as
   * an activation event.
   *
   * Shared by the hosted page and by `resolveCheckout` so the two cannot describe
   * the same purchase differently. The event id is derived from the checkout id
   * rather than random, which is what makes a settled page safe to reload: the
   * second delivery carries an id the receiver already holds and is absorbed by
   * the same `ON CONFLICT` that absorbs a provider's redelivery.
   */
  private activate(checkoutId: string, checkout: FakeCheckout): BillingEvent {
    const now = Date.now();
    const subscription: FakeSubscription = {
      id: `fake-sub-${checkoutId}`,
      tenantId: checkout.tenantId,
      planKey: checkout.planKey,
      seats: checkout.seats,
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodStart: new Date(now),
      currentPeriodEnd: new Date(now + PERIOD_LENGTH_MS),
    };

    this.subscriptions.set(checkout.tenantId, subscription);

    return this.toEvent(subscription, 'subscription.activated', `fake-checkout-${checkoutId}`);
  }

  private toEvent(
    subscription: FakeSubscription,
    type: BillingEvent['type'],
    providerEventId: string,
  ): BillingEvent {
    return {
      type,
      tenantId: subscription.tenantId,
      providerEventId,
      planKey: subscription.planKey,
      seats: subscription.seats,
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart.toISOString(),
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
      occurredAt: new Date().toISOString(),
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      cancelsAt: subscription.cancelAtPeriodEnd
        ? subscription.currentPeriodEnd.toISOString()
        : null,
      providerSubscriptionId: subscription.id,
      providerCustomerId: `fake-cus-${subscription.tenantId}`,
    };
  }
}

interface FakeCheckout {
  readonly tenantId: string;
  readonly planKey: string;
  readonly seats: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

interface FakeSubscription {
  readonly id: string;
  readonly tenantId: string;
  planKey: string;
  seats: number;
  status: BillingEvent['status'];
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}
