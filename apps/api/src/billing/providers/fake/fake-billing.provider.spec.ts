import type { ConfigService } from '@nestjs/config';
import { FAKE_CHECKOUT_ROUTE_PATH, FakeBillingProvider } from './fake-billing.provider';

const WEB_ORIGIN = 'https://console.localhost';
const TENANT_A = '0192f0ff-0000-7000-8000-0000000000a1';
const TENANT_B = '0192f0ff-0000-7000-8000-0000000000b2';

const SUCCESS_URL = 'https://acme.app.localhost/settings/billing?checkout=success';
const CANCEL_URL = 'https://acme.app.localhost/settings/billing?checkout=cancelled';

function providerFor(): FakeBillingProvider {
  return new FakeBillingProvider({
    getOrThrow: () => WEB_ORIGIN,
  } as unknown as ConfigService);
}

async function openCheckout(
  provider: FakeBillingProvider,
  overrides: { tenantId?: string; planKey?: string; seats?: number } = {},
): Promise<{ checkoutId: string; url: string }> {
  const session = await provider.createCheckout({
    tenantId: overrides.tenantId ?? TENANT_A,
    planKey: overrides.planKey ?? 'scale',
    seats: overrides.seats ?? 7,
    successUrl: SUCCESS_URL,
    cancelUrl: CANCEL_URL,
    providerProductId: null,
  });

  return { checkoutId: new URL(session.url).pathname.split('/').at(-1) ?? '', url: session.url };
}

/**
 * The half of the fake adapter that stands in for the provider's hosted page
 * (TAR-658). The rest of the adapter is exercised through the services that use
 * it; these are the properties nothing else covers, and the ones whose absence
 * left the fake driver with a checkout that could never complete.
 */
describe('FakeBillingProvider hosted checkout', () => {
  describe('createCheckout', () => {
    /**
     * The regression this file exists for. Sending the browser straight at the
     * success URL is what left the console on "confirming your payment" forever:
     * nothing was left in the flow that could ever produce a delivery.
     */
    it('sends the browser to the stand-in hosted page, not to the success URL', async () => {
      const { url } = await openCheckout(providerFor());

      expect(new URL(url).pathname).toMatch(new RegExp(`^/api/${FAKE_CHECKOUT_ROUTE_PATH}/`));
    });

    /**
     * The console proxies `/api/*` to this API, so staying on the return URL's
     * own host keeps the whole flow first-party to whatever host the tenant is
     * on — including a white-label one, which is not `WEB_ORIGIN`.
     */
    it('serves the page from the return URL host rather than the console origin', async () => {
      const { url } = await openCheckout(providerFor());

      expect(new URL(url).origin).toBe(new URL(SUCCESS_URL).origin);
    });

    /** A caller may pass a path; the link it gets back still has to open. */
    it('resolves a relative return URL against the console origin', async () => {
      const session = await providerFor().createCheckout({
        tenantId: TENANT_A,
        planKey: 'scale',
        seats: 7,
        successUrl: '/settings/billing?checkout=success',
        cancelUrl: '/settings/billing?checkout=cancelled',
        providerProductId: null,
      });

      expect(new URL(session.url).origin).toBe(WEB_ORIGIN);
    });
  });

  describe('settleHostedCheckout', () => {
    it('activates the plan and seats the session was opened for', async () => {
      const provider = providerFor();
      const { checkoutId } = await openCheckout(provider, { planKey: 'growth', seats: 12 });

      const settlement = provider.settleHostedCheckout(checkoutId, 'paid');

      expect(settlement?.redirectTo).toBe(SUCCESS_URL);
      expect(settlement?.event).toMatchObject({
        type: 'subscription.activated',
        tenantId: TENANT_A,
        planKey: 'growth',
        seats: 12,
        status: 'active',
      });
    });

    /** The activation has to be readable afterwards, or reconciliation disagrees. */
    it('leaves the subscription where getSubscription finds it', async () => {
      const provider = providerFor();
      const { checkoutId } = await openCheckout(provider);

      provider.settleHostedCheckout(checkoutId, 'paid');

      await expect(provider.getSubscription({ tenantId: TENANT_A })).resolves.toMatchObject({
        planKey: 'scale',
        seats: 7,
        status: 'active',
      });
    });

    /**
     * What makes reloading the settled page safe: the receiver keys idempotency
     * on the event id, so a second delivery is absorbed rather than re-applied.
     */
    it('reports the same event id every time a session is settled', async () => {
      const provider = providerFor();
      const { checkoutId } = await openCheckout(provider);

      const first = provider.settleHostedCheckout(checkoutId, 'paid');
      const again = provider.settleHostedCheckout(checkoutId, 'paid');

      expect(first?.event?.providerEventId).toBe(again?.event?.providerEventId);
    });

    it('buys nothing when the shopper backs out', async () => {
      const provider = providerFor();
      const { checkoutId } = await openCheckout(provider);

      const settlement = provider.settleHostedCheckout(checkoutId, 'cancelled');

      expect(settlement).toEqual({ redirectTo: CANCEL_URL, event: null });
      await expect(provider.getSubscription({ tenantId: TENANT_A })).resolves.toBeNull();
    });

    it('answers null for a session that was never opened', () => {
      expect(providerFor().settleHostedCheckout('not-a-session', 'paid')).toBeNull();
    });

    /**
     * Two tenants, because a fake that mixed them up would make every isolation
     * test downstream of it pass against the wrong subscription.
     */
    it('keeps one tenant checkout out of another tenant subscription', async () => {
      const provider = providerFor();
      const a = await openCheckout(provider, { tenantId: TENANT_A, planKey: 'scale', seats: 7 });
      const b = await openCheckout(provider, { tenantId: TENANT_B, planKey: 'growth', seats: 2 });

      provider.settleHostedCheckout(a.checkoutId, 'paid');
      provider.settleHostedCheckout(b.checkoutId, 'paid');

      await expect(provider.getSubscription({ tenantId: TENANT_A })).resolves.toMatchObject({
        planKey: 'scale',
        seats: 7,
      });
      await expect(provider.getSubscription({ tenantId: TENANT_B })).resolves.toMatchObject({
        planKey: 'growth',
        seats: 2,
      });
    });

    /** The session id is the only credential, so it must not be reachable across tenants. */
    it('refuses to resolve another tenant checkout', async () => {
      const provider = providerFor();
      const { checkoutId } = await openCheckout(provider, { tenantId: TENANT_A });

      await expect(
        provider.resolveCheckout({ tenantId: TENANT_B, checkoutId }),
      ).resolves.toBeNull();
    });
  });
});
