import type { BillingEvent } from '@whatsappcrm/contracts';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { uuidV7 } from '../prisma/uuid-v7';
import { SubscriptionSyncService } from './subscription-sync.service';

/**
 * The transaction that makes "the plan's limits take effect immediately" true,
 * against a real PostgreSQL (TAR-37, TAR-618).
 *
 * It is an integration test rather than a unit one for three reasons, and each
 * of them is a bug a mock would have hidden: the entitlements copy lands on a
 * column guarded by the `tenant_entitlements_shape` CHECK, `subscriptions`
 * carries a `NOT NULL` foreign key to `plans`, and the out-of-order guard
 * compares two `timestamptz` values the database round-trips. A fake transaction
 * client would agree with whatever the code did.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Fixture rows carry
 * fixed ids and are removed before the run as well as after it.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '40637777-7777-7777-8777-777777770001';
const TENANT_B = '40637777-7777-7777-8777-777777770002';

const PLAN_SMALL = '40637777-7777-7777-8777-7777777700a1';
const PLAN_LARGE = '40637777-7777-7777-8777-7777777700a2';

const PRODUCT_SMALL = 'prod_tar618_small';
const PRODUCT_LARGE = 'prod_tar618_large';

const PERIOD_START = '2026-08-01T00:00:00.000Z';
const PERIOD_END = '2026-09-01T00:00:00.000Z';

describe('SubscriptionSyncService against a real database', () => {
  let systemPrisma: PrismaClient;
  let service: SubscriptionSyncService;

  function event(overrides: Partial<BillingEvent> = {}): BillingEvent {
    return {
      type: 'subscription.activated',
      tenantId: TENANT_A,
      providerEventId: `evt-${uuidV7()}`,
      planKey: null,
      seats: 5,
      status: 'active',
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      occurredAt: '2026-08-01T00:00:00.000Z',
      providerProductId: PRODUCT_LARGE,
      providerSubscriptionId: 'sub_a',
      providerCustomerId: 'cus_a',
      ...overrides,
    };
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.subscription.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.plan.deleteMany({ where: { id: { in: [PLAN_SMALL, PLAN_LARGE] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    service = new SubscriptionSyncService(systemPrisma);

    await removeFixture();

    for (const [id, key, name, product, seats] of [
      [PLAN_SMALL, 'tar618_small', 'TAR-618 Small', PRODUCT_SMALL, 3],
      [PLAN_LARGE, 'tar618_large', 'TAR-618 Large', PRODUCT_LARGE, 25],
    ] as const) {
      await systemPrisma.plan.create({
        data: {
          id,
          key,
          name,
          priceMinorUnits: 1_000,
          currency: 'USD',
          interval: 'month',
          providerProductId: product,
          entitlements: planEntitlements(seats),
        },
      });
    }
  });

  afterAll(async () => {
    await removeFixture();
    await systemPrisma.$disconnect();
  });

  beforeEach(async () => {
    await systemPrisma.subscription.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });

    for (const [tenantId, slug] of [
      [TENANT_A, 'tar618-a'],
      [TENANT_B, 'tar618-b'],
    ] as const) {
      await systemPrisma.tenant.create({
        data: {
          id: tenantId,
          slug,
          name: `TAR-618 ${slug}`,
          status: 'trialing',
          entitlements: { create: { planKey: 'trial', entitlements: planEntitlements(3) } },
        },
      });
    }
  });

  describe('activation', () => {
    /**
     * TAR-37's first acceptance criterion: on completion the tenant's
     * subscription becomes active **and the plan's limits take effect
     * immediately**. `PlanLimitsService` reads `tenant_entitlements`, so the copy
     * is what makes "immediately" true rather than "at the next reconciliation".
     */
    it('writes the subscription and copies the plan onto the tenant in one go', async () => {
      const outcome = await service.apply(event());

      expect(outcome).toMatchObject({ result: 'applied', planKey: 'tar618_large', seats: 5 });

      const subscription = await systemPrisma.subscription.findUnique({
        where: { tenantId: TENANT_A },
      });

      expect(subscription).toMatchObject({
        planId: PLAN_LARGE,
        status: 'active',
        seats: 5,
        providerSubscriptionId: 'sub_a',
        providerCustomerId: 'cus_a',
      });
      expect(subscription?.currentPeriodStart?.toISOString()).toBe(PERIOD_START);

      const entitlements = await systemPrisma.tenantEntitlements.findUnique({
        where: { tenantId: TENANT_A },
      });

      expect(entitlements).toMatchObject({ planKey: 'tar618_large', planName: 'TAR-618 Large' });
      expect(entitlements?.entitlements).toMatchObject({ limits: { seats: 25 } });
    });

    /**
     * Polar knows a product uuid and nothing about our plan keys, so
     * `plans.provider_product_id` is the mapping. This is what that column exists
     * for.
     */
    it('resolves the plan by the provider product id', async () => {
      await service.apply(event({ providerProductId: PRODUCT_SMALL }));

      const entitlements = await systemPrisma.tenantEntitlements.findUnique({
        where: { tenantId: TENANT_A },
      });

      expect(entitlements?.planKey).toBe('tar618_small');
    });

    /** And by plan key, for a provider that speaks our vocabulary — the fake does. */
    it('resolves the plan by key when no product id is carried', async () => {
      await service.apply(event({ providerProductId: undefined, planKey: 'tar618_small' }));

      const subscription = await systemPrisma.subscription.findUnique({
        where: { tenantId: TENANT_A },
      });

      expect(subscription?.planId).toBe(PLAN_SMALL);
    });

    /**
     * `subscriptions.plan_id` is `NOT NULL` and there is no prior row to inherit
     * it from. Parked rather than retried, because no number of redeliveries
     * invents a catalogue row.
     */
    it('refuses an unmapped product rather than writing a half-populated row', async () => {
      const outcome = await service.apply(event({ providerProductId: 'prod_never_seeded' }));

      expect(outcome).toMatchObject({ result: 'unresolved_plan' });
      await expect(
        systemPrisma.subscription.findUnique({ where: { tenantId: TENANT_A } }),
      ).resolves.toBeNull();
    });
  });

  describe('replay and ordering', () => {
    /**
     * TAR-37's fourth acceptance criterion. A redelivery of the same event
     * changes nothing, and the row is not re-stamped.
     */
    it('applies a replayed event exactly once', async () => {
      const replayed = event();

      await service.apply(replayed);
      const first = await systemPrisma.subscription.findUnique({ where: { tenantId: TENANT_A } });

      await service.apply(replayed);
      const second = await systemPrisma.subscription.findUnique({ where: { tenantId: TENANT_A } });

      expect(second?.lastEventAt?.toISOString()).toBe(first?.lastEventAt?.toISOString());
      expect(second?.status).toBe(first?.status);
      expect(second?.seats).toBe(first?.seats);
    });

    /**
     * The failure this guard exists for: a retried `past_due` landing after a
     * fresh `active` would walk a tenant backwards into dunning it has already
     * left — a lockout caused entirely by delivery order.
     */
    it('drops an event older than the one that last wrote the row', async () => {
      await service.apply(event({ occurredAt: '2026-08-10T00:00:00.000Z', status: 'active' }));

      const outcome = await service.apply(
        event({
          type: 'subscription.past_due',
          status: 'past_due',
          occurredAt: '2026-08-09T00:00:00.000Z',
        }),
      );

      expect(outcome).toEqual({ result: 'stale' });

      const subscription = await systemPrisma.subscription.findUnique({
        where: { tenantId: TENANT_A },
      });

      expect(subscription?.status).toBe('active');
      expect(subscription?.pastDueSince).toBeNull();
    });

    it('applies a newer event over an older one', async () => {
      await service.apply(event({ occurredAt: '2026-08-09T00:00:00.000Z' }));
      await service.apply(
        event({
          type: 'subscription.past_due',
          status: 'past_due',
          occurredAt: '2026-08-10T00:00:00.000Z',
        }),
      );

      const subscription = await systemPrisma.subscription.findUnique({
        where: { tenantId: TENANT_A },
      });

      expect(subscription?.status).toBe('past_due');
      expect(subscription?.pastDueSince?.toISOString()).toBe('2026-08-10T00:00:00.000Z');
    });
  });

  describe('cancellation columns', () => {
    /**
     * A cancellation *request* is not a cancellation: the tenant has paid through
     * `cancels_at` and stays fully serviceable until it. These two columns are
     * what the console renders its banner from.
     */
    it('records a requested cancellation without moving the status', async () => {
      await service.apply(event());
      await service.apply(
        event({
          type: 'subscription.updated',
          status: 'active',
          occurredAt: '2026-08-05T00:00:00.000Z',
          cancelAtPeriodEnd: true,
          cancelsAt: PERIOD_END,
        }),
      );

      const subscription = await systemPrisma.subscription.findUnique({
        where: { tenantId: TENANT_A },
      });

      expect(subscription?.status).toBe('active');
      expect(subscription?.cancelAtPeriodEnd).toBe(true);
      expect(subscription?.cancelsAt?.toISOString()).toBe(PERIOD_END);
    });

    it('clears them when the cancellation is withdrawn', async () => {
      await service.apply(event());
      await service.apply(
        event({
          occurredAt: '2026-08-05T00:00:00.000Z',
          cancelAtPeriodEnd: true,
          cancelsAt: PERIOD_END,
        }),
      );
      await service.apply(
        event({
          occurredAt: '2026-08-06T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          cancelsAt: null,
        }),
      );

      const subscription = await systemPrisma.subscription.findUnique({
        where: { tenantId: TENANT_A },
      });

      expect(subscription?.cancelAtPeriodEnd).toBe(false);
      expect(subscription?.cancelsAt).toBeNull();
    });

    /**
     * `undefined` means "this event says nothing about cancellation". Collapsing
     * it with `false` would make every routine update silently un-cancel a
     * subscription the customer asked to end.
     */
    it('leaves a pending cancellation alone when an event says nothing about it', async () => {
      await service.apply(event());
      await service.apply(
        event({
          occurredAt: '2026-08-05T00:00:00.000Z',
          cancelAtPeriodEnd: true,
          cancelsAt: PERIOD_END,
        }),
      );
      await service.apply(
        event({
          type: 'payment.succeeded',
          occurredAt: '2026-08-06T00:00:00.000Z',
          cancelAtPeriodEnd: undefined,
          cancelsAt: undefined,
        }),
      );

      const subscription = await systemPrisma.subscription.findUnique({
        where: { tenantId: TENANT_A },
      });

      expect(subscription?.cancelAtPeriodEnd).toBe(true);
    });
  });

  describe('past_due_since', () => {
    it('keeps the first report rather than restamping on every retry', async () => {
      await service.apply(
        event({
          type: 'subscription.past_due',
          status: 'past_due',
          occurredAt: '2026-08-10T00:00:00.000Z',
        }),
      );
      await service.apply(
        event({
          type: 'subscription.past_due',
          status: 'past_due',
          occurredAt: '2026-08-11T00:00:00.000Z',
        }),
      );

      const subscription = await systemPrisma.subscription.findUnique({
        where: { tenantId: TENANT_A },
      });

      expect(subscription?.pastDueSince?.toISOString()).toBe('2026-08-10T00:00:00.000Z');
    });

    it('clears once the subscription is anything else', async () => {
      await service.apply(
        event({
          type: 'subscription.past_due',
          status: 'past_due',
          occurredAt: '2026-08-10T00:00:00.000Z',
        }),
      );
      await service.apply(
        event({
          type: 'payment.succeeded',
          status: 'active',
          occurredAt: '2026-08-12T00:00:00.000Z',
        }),
      );

      const subscription = await systemPrisma.subscription.findUnique({
        where: { tenantId: TENANT_A },
      });

      expect(subscription?.pastDueSince).toBeNull();
    });
  });

  /**
   * The rule every test touching tenant data carries: one tenant's billing event
   * must be unobservable to another. `SystemPrisma` is unscoped by necessity
   * here — the worker has no session and often no serviceable tenant — so the
   * *only* thing keeping these apart is that every statement names one tenant by
   * id, and that is what this asserts.
   */
  it('applies a tenant event to that tenant and to nobody else', async () => {
    await service.apply(event({ tenantId: TENANT_A, providerProductId: PRODUCT_LARGE }));

    await expect(
      systemPrisma.subscription.findUnique({ where: { tenantId: TENANT_B } }),
    ).resolves.toBeNull();

    const untouched = await systemPrisma.tenantEntitlements.findUnique({
      where: { tenantId: TENANT_B },
    });

    expect(untouched?.planKey).toBe('trial');
    expect(untouched?.entitlements).toMatchObject({ limits: { seats: 3 } });
  });

  /**
   * A tenant provisioned before `tenant_entitlements` existed has no row, and a
   * missing row must not fail a paid activation — `PlanLimitsService` reads it as
   * unlimited, which is the open direction the class documents at length.
   */
  it('still activates a tenant that has no entitlements row', async () => {
    await systemPrisma.tenantEntitlements.deleteMany({ where: { tenantId: TENANT_A } });

    await expect(service.apply(event())).resolves.toMatchObject({ result: 'applied' });
    await expect(
      systemPrisma.subscription.findUnique({ where: { tenantId: TENANT_A } }),
    ).resolves.not.toBeNull();
  });
});

/** The shape both `plans_entitlements_shape` and `tenant_entitlements_shape` require. */
function planEntitlements(seats: number | null): Prisma.InputJsonValue {
  return {
    features: ['assignment_rules'],
    limits: {
      seats,
      conversationsPerPeriod: 1_000,
      whatsappNumbers: 1,
      teams: 2,
      knowledgeDocuments: 10,
    },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Run the suite through \`pnpm test:db\` with the stack up: ` +
        'pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login',
    );
  }

  return value;
}
