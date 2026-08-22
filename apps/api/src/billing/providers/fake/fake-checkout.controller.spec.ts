import type { ConfigService } from '@nestjs/config';
import type { BillingProvider } from '@whatsappcrm/contracts';
import { ApiException } from '../../../common/errors/api.exception';
import type { BillingWebhookService } from '../../billing-webhook.service';
import { FakeBillingProvider } from './fake-billing.provider';
import { FakeCheckoutController } from './fake-checkout.controller';

const WEB_ORIGIN = 'https://console.localhost';
const TENANT = '0192f0ff-0000-7000-8000-0000000000a1';
const SUCCESS_URL = 'https://acme.app.localhost/settings/billing?checkout=success';
const CANCEL_URL = 'https://acme.app.localhost/settings/billing?checkout=cancelled';

function fakeProvider(): FakeBillingProvider {
  return new FakeBillingProvider({ getOrThrow: () => WEB_ORIGIN } as unknown as ConfigService);
}

function controllerWith(provider: BillingProvider) {
  const ingest = jest.fn().mockResolvedValue('stored');
  const controller = new FakeCheckoutController(provider, {
    ingest,
  } as unknown as BillingWebhookService);

  return { controller, ingest };
}

async function openCheckout(provider: FakeBillingProvider): Promise<string> {
  const session = await provider.createCheckout({
    tenantId: TENANT,
    planKey: 'scale',
    seats: 7,
    successUrl: SUCCESS_URL,
    cancelUrl: CANCEL_URL,
    providerProductId: null,
  });

  return new URL(session.url).pathname.split('/').at(-1) ?? '';
}

/**
 * The stand-in hosted page (TAR-658). What matters here is not that it redirects
 * — it is that settling produces a delivery the *ordinary* receiver accepts, so
 * the fake driver rehearses the real activation path instead of writing a
 * subscription behind the webhook's back.
 */
describe('FakeCheckoutController', () => {
  describe('a payment', () => {
    it('delivers an activation the fake adapter itself would accept', async () => {
      const provider = fakeProvider();
      const { controller, ingest } = controllerWith(provider);
      const checkoutId = await openCheckout(provider);

      await controller.settle(checkoutId, { outcome: 'paid' });

      expect(ingest).toHaveBeenCalledTimes(1);

      const [rawBody, headers] = ingest.mock.calls[0] as [
        Buffer,
        Record<string, string | undefined>,
      ];

      // The delivery is checked by the same verification a Polar one goes
      // through; a body this adapter would refuse is a fake that proves nothing.
      expect(provider.verifyWebhookSignature(rawBody, headers)).toBe(true);
      expect(
        provider.parseWebhookEvent(JSON.parse(rawBody.toString('utf8')), headers, TENANT),
      ).toMatchObject({ type: 'subscription.activated', planKey: 'scale', seats: 7 });
    });

    /** The header the receiver keys idempotency on; without it every delivery is refused. */
    it('carries a webhook id and a fresh timestamp', async () => {
      const provider = fakeProvider();
      const { controller, ingest } = controllerWith(provider);
      const checkoutId = await openCheckout(provider);

      await controller.settle(checkoutId, { outcome: 'paid' });

      const [, headers] = ingest.mock.calls[0] as [Buffer, Record<string, string>];

      expect(headers['webhook-id']).toMatch(/^fake-checkout-/);
      expect(Math.abs(Date.now() / 1_000 - Number(headers['webhook-timestamp']))).toBeLessThan(60);
    });

    it('sends the browser to the return URL the session was opened with', async () => {
      const provider = fakeProvider();
      const { controller } = controllerWith(provider);
      const checkoutId = await openCheckout(provider);

      await expect(controller.settle(checkoutId, { outcome: 'paid' })).resolves.toEqual({
        url: SUCCESS_URL,
      });
    });

    /**
     * A shopper who lands on a success page for a subscription nothing is going
     * to activate is worse off than one who sees the failure.
     */
    it('does not redirect when the delivery could not be made', async () => {
      const provider = fakeProvider();
      const { controller, ingest } = controllerWith(provider);
      const checkoutId = await openCheckout(provider);

      ingest.mockRejectedValue(new Error('receiver down'));

      await expect(controller.settle(checkoutId, { outcome: 'paid' })).rejects.toThrow(
        'receiver down',
      );
    });
  });

  describe('a cancellation', () => {
    it('redirects without delivering anything', async () => {
      const provider = fakeProvider();
      const { controller, ingest } = controllerWith(provider);
      const checkoutId = await openCheckout(provider);

      await expect(controller.settle(checkoutId, { outcome: 'cancelled' })).resolves.toEqual({
        url: CANCEL_URL,
      });
      expect(ingest).not.toHaveBeenCalled();
    });
  });

  describe('what it refuses', () => {
    it('answers not_found for a session that was never opened', async () => {
      const { controller, ingest } = controllerWith(fakeProvider());

      await expect(controller.settle('not-a-session', { outcome: 'paid' })).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(ingest).not.toHaveBeenCalled();
    });

    /**
     * The gate. On the real rail there is no stand-in page, and the route has to
     * answer as though it were never written — a route that activated a
     * subscription without a Polar payment would be the worst bug in the module.
     */
    it('does not exist when the bound adapter is not the fake', async () => {
      const { controller, ingest } = controllerWith({} as unknown as BillingProvider);

      const settle = controller.settle('any-session', { outcome: 'paid' });

      await expect(settle).rejects.toBeInstanceOf(ApiException);
      await expect(settle).rejects.toMatchObject({ code: 'not_found' });
      expect(ingest).not.toHaveBeenCalled();
    });
  });
});
