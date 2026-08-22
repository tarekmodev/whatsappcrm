import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BillingEvent,
  BillingProvider,
  HostedSession,
  WebhookSubject,
} from '@whatsappcrm/contracts';

/** How long a fake checkout session stays resolvable. Long enough to click through. */
const SESSION_LIFETIME_MS = 30 * 60 * 1_000;

/** A fake period, so `UsagePeriodResolver` has real bounds to key counters on. */
const PERIOD_LENGTH_MS = 30 * 24 * 60 * 60 * 1_000;

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
    // Where the fake "hosted page" sends the browser. It is the console's own
    // origin, so a developer clicking Upgrade lands back in the app with a
    // checkout id to resolve rather than on a dead link.
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

    this.checkouts.set(checkoutId, {
      tenantId: input.tenantId,
      planKey: input.planKey,
      seats: input.seats,
    });

    // The `successUrl` with the checkout id appended, which is what a real
    // hosted page redirects to. The console's return handler is therefore
    // exercised locally exactly as it will be against Polar.
    const url = new URL(input.successUrl, this.consoleOrigin);

    url.searchParams.set('checkout_id', checkoutId);

    return Promise.resolve({
      url: url.toString(),
      expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS).toISOString(),
    });
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
    const envelope = payload as { data?: { tenantId?: unknown } } | null;
    const tenantId = envelope?.data?.tenantId;

    return {
      tenantId: typeof tenantId === 'string' ? tenantId : null,
      // The fake speaks our vocabulary, so there is nothing opaque to fall back
      // to and no provider-side row to look up.
      providerSubscriptionId: null,
      providerCustomerId: null,
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
  ): BillingEvent | null {
    const providerEventId = headers['webhook-id'];
    const envelope = payload as { data?: unknown } | null;

    if (
      providerEventId === undefined ||
      typeof envelope?.data !== 'object' ||
      envelope.data === null
    ) {
      return null;
    }

    return { ...(envelope.data as BillingEvent), tenantId, providerEventId };
  }

  resolveCheckout(input: { tenantId: string; checkoutId: string }): Promise<BillingEvent | null> {
    const checkout = this.checkouts.get(input.checkoutId);

    if (checkout === undefined || checkout.tenantId !== input.tenantId) {
      // Either the session never existed or it belongs to another tenant. Both
      // answer `null` — a checkout id is guessable, and confirming that one
      // exists for somebody else is a cross-tenant disclosure however small.
      return Promise.resolve(null);
    }

    const now = Date.now();
    const subscription: FakeSubscription = {
      id: `fake-sub-${input.checkoutId}`,
      tenantId: checkout.tenantId,
      planKey: checkout.planKey,
      seats: checkout.seats,
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodStart: new Date(now),
      currentPeriodEnd: new Date(now + PERIOD_LENGTH_MS),
    };

    this.subscriptions.set(checkout.tenantId, subscription);

    return Promise.resolve(
      this.toEvent(subscription, 'subscription.activated', `fake-checkout-${input.checkoutId}`),
    );
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
