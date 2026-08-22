import {
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  Query,
  Redirect,
  UseFilters,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { BILLING_PROVIDER, type BillingEvent, type BillingProvider } from '@whatsappcrm/contracts';
import { z } from 'zod';
import { ApiExceptionFilter } from '../../../common/errors/api-exception.filter';
import { ApiException } from '../../../common/errors/api.exception';
import { PlatformRoute } from '../../../common/request-pipeline/route-access';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { BillingWebhookService } from '../../billing-webhook.service';
import { FAKE_CHECKOUT_ROUTE_PATH, FakeBillingProvider } from './fake-billing.provider';

/** Standard Webhooks' headers, lower-cased as Express indexes them. */
const WEBHOOK_ID_HEADER = 'webhook-id';
const WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp';
const WEBHOOK_SIGNATURE_HEADER = 'webhook-signature';

/** Bounded and opaque — it is only ever handed back to the adapter that minted it. */
const CheckoutIdSchema = z.string().min(1).max(200);

/**
 * What the shopper "did" on the page. `paid` by default, because the link the
 * console opens is the pay-and-return path and the cancel button is the
 * deliberate detour.
 */
const SettleQuerySchema = z.object({
  outcome: z.enum(['paid', 'cancelled']).default('paid'),
});

type SettleQuery = z.infer<typeof SettleQuerySchema>;

/**
 * The stand-in for the provider's hosted checkout page, served only when
 * `BILLING_PROVIDER_DRIVER=fake` (TAR-658).
 *
 * ## The gap it closes
 *
 * A fake payment provider can do everything a real one does except the one thing
 * that actually activates a subscription: **call back**. There is no external
 * system to deliver a webhook, so under the fake driver a checkout was opened and
 * then nothing ever happened — the console sat on "confirming your payment"
 * forever and TAR-37's "checkout completes → limits take effect" could not be
 * demonstrated anywhere. Every environment runs the fake driver until Polar
 * credentials are provisioned, so that was every environment.
 *
 * The missing half is not an endpoint that writes a subscription — TAR-651
 * removed one of those, correctly, and the webhook is still the single writer.
 * The missing half is the *page*: with Polar, the delivery happens because a
 * shopper settled a hosted session. So this is that page. It settles the session,
 * and the activation it produces is delivered through
 * `BillingWebhookService.ingest`, signed by the fake adapter's own key — the same
 * bytes, the same signature check, the same replay absorption, the same queue and
 * the same `SubscriptionSyncService` a Polar delivery goes through.
 *
 * ## Why it is unauthenticated, and why that is not a hole
 *
 * `@PlatformRoute()`, like the webhook receiver: a hosted checkout page is
 * reached by a browser that carries no session of ours, and the unguessable
 * session id in the URL is what stands in for a credential. That is the real
 * provider's posture, and copying it is what makes this a rehearsal rather than a
 * shortcut.
 *
 * What possession of the id grants is bounded: the fake adapter holds the tenant,
 * plan and seats that were chosen when the session was opened, and nothing in the
 * request can change any of them — not the plan, not the tenant, not even where
 * the browser is sent afterwards. Settling twice is absorbed by the receiver,
 * because the event id is derived from the checkout id.
 *
 * ## It does not exist on the real rail
 *
 * The route is mounted unconditionally but answers `not_found` unless the bound
 * adapter *is* the fake. The check is `instanceof` rather than a second read of
 * `BILLING_PROVIDER_DRIVER` on purpose: there is then no configuration a
 * deployment can hold that makes the gate and the binding disagree, and the
 * narrowing is what gives the handler the fake-only methods it needs.
 */
@Controller({ path: FAKE_CHECKOUT_ROUTE_PATH, version: VERSION_NEUTRAL })
@PlatformRoute()
@UseFilters(ApiExceptionFilter)
export class FakeCheckoutController {
  private readonly logger = new Logger(FakeCheckoutController.name);

  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly webhooks: BillingWebhookService,
  ) {}

  /**
   * `GET /api/billing/fake-checkout/:checkoutId` — settle the session and send
   * the browser back where it came from.
   *
   * A `GET` because a browser follows a redirect into it, which is exactly how a
   * hosted page is reached. It is not idempotent in the strict sense — the first
   * call activates — but it is *repeatable*: the delivery it makes carries a
   * deterministic event id, so a reload settles nothing new.
   *
   * The redirect happens whether or not the delivery was a duplicate. What it
   * must never do is redirect after failing to deliver: the shopper would land on
   * a success page for a subscription nothing is going to activate, so an ingest
   * failure is left to propagate.
   */
  @Get(':checkoutId')
  @Redirect()
  async settle(
    @Param('checkoutId', new ZodValidationPipe(CheckoutIdSchema)) checkoutId: string,
    @Query(new ZodValidationPipe(SettleQuerySchema)) query: SettleQuery,
  ): Promise<{ url: string }> {
    const provider = this.requireFakeProvider();
    const settlement = provider.settleHostedCheckout(checkoutId, query.outcome);

    if (settlement === null) {
      // No such session. `not_found` and nothing else — a checkout id is
      // guessable in principle, and confirming that one exists is a signal an
      // anonymous caller should not get.
      throw new ApiException('not_found', 'No such checkout session.');
    }

    if (settlement.event !== null) {
      await this.deliver(provider, settlement.event);
    }

    return { url: settlement.redirectTo };
  }

  /**
   * Posts the activation to the ordinary receiver, signed the way the adapter
   * signs anything else.
   *
   * Calling `ingest` in process rather than making an HTTP request to ourselves:
   * the bytes, the headers and every check they pass through are identical, and a
   * self-call over the network would need an origin this API is not configured
   * with and would turn a fake purchase into a distributed failure mode.
   */
  private async deliver(provider: FakeBillingProvider, event: BillingEvent): Promise<void> {
    // The envelope `FakeBillingProvider.parseWebhookEvent` reads back.
    const rawBody = Buffer.from(JSON.stringify({ type: event.type, data: event }), 'utf8');

    const outcome = await this.webhooks.ingest(rawBody, {
      [WEBHOOK_ID_HEADER]: event.providerEventId,
      // Seconds since the epoch, which is what `assertFreshTimestamp` parses.
      [WEBHOOK_TIMESTAMP_HEADER]: Math.floor(Date.now() / 1_000).toString(),
      [WEBHOOK_SIGNATURE_HEADER]: provider.sign(rawBody),
    });

    this.logger.log(
      `Fake checkout delivered ${event.providerEventId} for tenant ${event.tenantId} (${outcome})`,
    );
  }

  /**
   * The gate and the narrowing in one place: on the real rail there is no
   * stand-in page, and the route answers as though it were never written.
   */
  private requireFakeProvider(): FakeBillingProvider {
    if (!(this.provider instanceof FakeBillingProvider)) {
      throw new ApiException('not_found', 'No such checkout session.');
    }

    return this.provider;
  }
}
