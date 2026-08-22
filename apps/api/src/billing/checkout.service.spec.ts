import type { BillingProvider } from '@whatsappcrm/contracts';
import type { PlanLimitsService } from '../entitlements/plan-limits.service';
import type { UsageCounterService } from '../entitlements/usage-counter.service';
import type { TenantLinkService } from '../identity/mailer/tenant-link.service';
import type { Prisma } from '../generated/prisma/client';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { TenantLifecycleService } from '../tenancy/lifecycle/tenant-lifecycle.service';
import { CheckoutService } from './checkout.service';
import {
  BillingProviderUnavailableError,
  NoSubscriptionError,
  PlanDowngradeBlockedError,
  PlanNotFoundError,
} from './billing.errors';
import type { SubscriptionSyncService } from './subscription-sync.service';

const TENANT = '0192f0ff-0000-7000-8000-0000000000a1';
const ORIGIN = 'https://acme.app.localhost';

interface Fixture {
  plan?: { key: string; providerProductId: string | null; entitlements: unknown } | null;
  seatsUsed?: number;
  seatsPending?: number;
  conversations?: number;
  subscription?: { providerCustomerId: string | null } | null;
  absoluteUrl?: jest.Mock;
}

function serviceWith(fixture: Fixture) {
  const createCheckout = jest
    .fn()
    .mockResolvedValue({ url: 'https://checkout.example/abc', expiresAt: null });
  const createPortalSession = jest
    .fn()
    .mockResolvedValue({ url: 'https://portal.example/abc', expiresAt: null });

  const tx = {
    plan: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          fixture.plan === undefined
            ? { key: 'growth', providerProductId: 'prod_growth', entitlements: { limits: {} } }
            : fixture.plan,
        ),
    },
  } as unknown as Prisma.TransactionClient;

  const prisma = {
    $tenantTransaction: <T>(work: (client: Prisma.TransactionClient) => Promise<T>) => work(tx),
    subscription: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          fixture.subscription === undefined
            ? { providerCustomerId: 'cus_abc' }
            : fixture.subscription,
        ),
    },
  } as unknown as TenantPrisma;

  const absoluteUrl =
    fixture.absoluteUrl ?? jest.fn().mockImplementation((path: string) => `${ORIGIN}${path}`);

  const service = new CheckoutService(
    { createCheckout, createPortalSession } as unknown as BillingProvider,
    prisma,
    {
      seatUsage: jest.fn().mockResolvedValue({
        seatsUsed: fixture.seatsUsed ?? 2,
        seatsPending: fixture.seatsPending ?? 1,
      }),
    } as unknown as PlanLimitsService,
    {
      current: jest.fn().mockResolvedValue({ value: fixture.conversations ?? 100 }),
    } as unknown as UsageCounterService,
    { absoluteUrl } as unknown as TenantLinkService,
    { apply: jest.fn() } as unknown as SubscriptionSyncService,
    { applyBillingEvent: jest.fn() } as unknown as TenantLifecycleService,
  );

  return { service, createCheckout, createPortalSession, absoluteUrl };
}

describe('CheckoutService', () => {
  describe('return URLs', () => {
    /**
     * A payment provider redirects the browser to whatever `success_url` it is
     * handed, so an absolute URL from a client would be an open redirect with a
     * payment page in front of it — the one screen where a user is most primed
     * to trust where they land. The published contract carries a *path*, and the
     * host comes from the control plane.
     */
    it('composes the caller supplied paths against the tenant host', async () => {
      const { service, createCheckout, absoluteUrl } = serviceWith({});

      await service.createCheckout(TENANT, {
        planKey: 'growth',
        successPath: '/done',
        cancelPath: '/back',
      });

      expect(absoluteUrl).toHaveBeenCalledWith('/done');
      expect(absoluteUrl).toHaveBeenCalledWith('/back');
      expect(createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          successUrl: `${ORIGIN}/done`,
          cancelUrl: `${ORIGIN}/back`,
        }),
      );
    });

    /**
     * There is nowhere legitimate to send the browser back to, and inventing one
     * is exactly what the rule exists to prevent — so checkout does not open.
     */
    it('refuses to open a checkout for a tenant with no deliverable domain', async () => {
      const { service, createCheckout } = serviceWith({
        absoluteUrl: jest.fn().mockResolvedValue(null),
      });

      await expect(service.createCheckout(TENANT, { planKey: 'growth' })).rejects.toBeInstanceOf(
        BillingProviderUnavailableError,
      );
      expect(createCheckout).not.toHaveBeenCalled();
    });
  });

  describe('seats', () => {
    /** Members plus every live invitation — the number the invite check enforces on. */
    it('defaults to the seats already held', async () => {
      const { service, createCheckout } = serviceWith({ seatsUsed: 4, seatsPending: 2 });

      await service.createCheckout(TENANT, { planKey: 'growth' });

      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ seats: 6 }));
    });

    /**
     * Checking out for fewer seats than are in use would create a subscription
     * that is over its own cap the moment it activates.
     */
    it('never goes below what is held, whatever the caller asked for', async () => {
      const { service, createCheckout } = serviceWith({ seatsUsed: 4, seatsPending: 2 });

      await service.createCheckout(TENANT, { planKey: 'growth', seats: 1 });

      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ seats: 6 }));
    });

    it('honours a larger request', async () => {
      const { service, createCheckout } = serviceWith({ seatsUsed: 2, seatsPending: 0 });

      await service.createCheckout(TENANT, { planKey: 'growth', seats: 20 });

      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ seats: 20 }));
    });
  });

  describe('a downgrade is refused before the money moves', () => {
    /**
     * The console disabling the button is a courtesy; this is the enforcement. A
     * tenant that paid for a plan it is already over would be refused its next
     * invite with an invoice in hand.
     */
    it('refuses a plan whose seat ceiling is below current usage', async () => {
      const { service, createCheckout } = serviceWith({
        seatsUsed: 8,
        seatsPending: 2,
        plan: {
          key: 'starter',
          providerProductId: 'prod_starter',
          entitlements: { limits: { seats: 3 } },
        },
      });

      await expect(service.createCheckout(TENANT, { planKey: 'starter' })).rejects.toMatchObject({
        limit: 'seats',
        cap: 3,
        used: 10,
      });
      expect(createCheckout).not.toHaveBeenCalled();
    });

    it('refuses a plan whose conversation ceiling is below what this period has used', async () => {
      const { service } = serviceWith({
        conversations: 4_000,
        plan: {
          key: 'starter',
          providerProductId: 'prod_starter',
          entitlements: { limits: { conversationsPerPeriod: 1_000 } },
        },
      });

      await expect(service.createCheckout(TENANT, { planKey: 'starter' })).rejects.toBeInstanceOf(
        PlanDowngradeBlockedError,
      );
    });

    /** `null` is unlimited — deliberately not `-1` or a sentinel maximum. */
    it('allows an unlimited plan whatever the usage', async () => {
      const { service, createCheckout } = serviceWith({
        seatsUsed: 500,
        conversations: 900_000,
        plan: {
          key: 'scale',
          providerProductId: 'prod_scale',
          entitlements: { limits: { seats: null, conversationsPerPeriod: null } },
        },
      });

      await service.createCheckout(TENANT, { planKey: 'scale' });

      expect(createCheckout).toHaveBeenCalled();
    });
  });

  it('refuses a plan that is not in the catalogue', async () => {
    const { service } = serviceWith({ plan: null });

    await expect(service.createCheckout(TENANT, { planKey: 'ghost' })).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
  });

  /**
   * The product id is read here and passed through untouched — the adapter
   * cannot look it up, because the catalogue is ours.
   */
  it('passes the provider product id through without interpreting it', async () => {
    const { service, createCheckout } = serviceWith({});

    await service.createCheckout(TENANT, { planKey: 'growth' });

    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ providerProductId: 'prod_growth' }),
    );
  });

  describe('the customer portal', () => {
    it('opens a session for a tenant that has a provider customer', async () => {
      const { service, createPortalSession } = serviceWith({});

      await service.createPortalSession(TENANT, { returnPath: '/settings/billing' });

      expect(createPortalSession).toHaveBeenCalledWith({
        tenantId: TENANT,
        returnUrl: `${ORIGIN}/settings/billing`,
      });
    });

    /**
     * A tenant that has never completed a checkout has no provider-side customer
     * to open a portal for, and the console's answer is to offer checkout.
     */
    it('answers not-found for a tenant that has never checked out', async () => {
      const { service, createPortalSession } = serviceWith({ subscription: null });

      await expect(service.createPortalSession(TENANT, {})).rejects.toBeInstanceOf(
        NoSubscriptionError,
      );
      expect(createPortalSession).not.toHaveBeenCalled();
    });
  });
});
