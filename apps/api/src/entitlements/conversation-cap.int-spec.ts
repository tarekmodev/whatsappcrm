import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { PlanLimitExceededError } from './entitlements.errors';
import { PlanLimitsService } from './plan-limits.service';
import { UsageCounterService } from './usage-counter.service';
import { UsagePeriodResolver } from './usage-period.resolver';

/**
 * The conversation-volume cap and the period it meters against, as
 * `whatsappcrm_app` — the role holding no `BYPASSRLS` (TAR-405).
 *
 * The period arithmetic is the reason this is an integration test rather than a
 * unit one. It is deliberately done in Postgres, because `created_at + n months`
 * clamps a 31st to the length of the target month while JavaScript's `setMonth`
 * overflows it into the following one — so a test that reimplemented the
 * arithmetic in JS would agree with a bug rather than catch it. The month-end
 * cases below only mean anything against a real server.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Fixture tenants carry
 * fixed ids and are removed before the run as well as after it.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '40544444-4444-7444-8444-444444444401';
const TENANT_B = '40544444-4444-7444-8444-444444444402';

const REQUEST_ID = 'tar405-cap-int-spec';

/** Small enough that the fixture can sit exactly on it. */
const CAP = 3;

describe('the conversation-volume cap', () => {
  const tenantContext = new TenantContextService();
  const periods = new UsagePeriodResolver();
  const usage = new UsageCounterService(periods);
  const planLimits = new PlanLimitsService(usage);

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  function inTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null, principal: null },
      () => tenantPrisma.$tenantTransaction(work),
    );
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  /** Moves a tenant's anchor, so a period boundary can be put where a test wants it. */
  async function anchorAt(tenantId: string, createdAt: string): Promise<void> {
    await systemPrisma.$executeRaw`
      UPDATE tenants SET created_at = ${new Date(createdAt)} WHERE id = ${tenantId}::uuid
    `;
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    for (const [tenantId, slug] of [
      [TENANT_A, 'tar405-cap-a'],
      [TENANT_B, 'tar405-cap-b'],
    ] as const) {
      await systemPrisma.tenant.create({
        data: {
          id: tenantId,
          slug,
          name: `TAR-405 cap ${slug}`,
          // The state self-signup lands a tenant in, and the one the cap exists
          // for. Also proves the database gate admits it: every statement below
          // passes through `assert_tenant_active`.
          status: 'trialing',
          domains: {
            create: {
              hostname: `${slug}.app.localhost`,
              kind: 'platform',
              isPrimary: true,
              verifiedAt: new Date(),
            },
          },
          entitlements: { create: { planKey: 'trial', entitlements: entitlementsWithCap(CAP) } },
        },
      });
    }
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await systemPrisma.usageCounter.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.tenantEntitlements.updateMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
      data: { entitlements: entitlementsWithCap(CAP) },
    });
    await anchorAt(TENANT_A, '2026-01-10T09:00:00.000Z');
    await anchorAt(TENANT_B, '2026-01-10T09:00:00.000Z');
  });

  describe('the period', () => {
    it('is the anniversary month containing the instant, taken from the anchor', async () => {
      const period = await inTenant(TENANT_A, (tx) =>
        periods.resolve(tx, TENANT_A, new Date('2026-03-15T00:00:00.000Z')),
      );

      expect(period.start.toISOString()).toBe('2026-03-10T09:00:00.000Z');
      expect(period.end.toISOString()).toBe('2026-04-10T09:00:00.000Z');
    });

    it('puts the anchor instant itself in the first period', async () => {
      const period = await inTenant(TENANT_A, (tx) =>
        periods.resolve(tx, TENANT_A, new Date('2026-01-10T09:00:00.000Z')),
      );

      expect(period.start.toISOString()).toBe('2026-01-10T09:00:00.000Z');
    });

    /**
     * The case that makes doing this in Postgres load-bearing. A 31 January
     * anchor has no 31 February to land on: Postgres clamps to the 28th, while
     * `Date.setMonth` would roll forward to 3 March and put the boundary two days
     * into a period it does not belong to.
     */
    it('clamps a month-end anchor rather than overflowing it', async () => {
      await anchorAt(TENANT_A, '2026-01-31T12:00:00.000Z');

      const february = await inTenant(TENANT_A, (tx) =>
        periods.resolve(tx, TENANT_A, new Date('2026-02-20T00:00:00.000Z')),
      );

      expect(february.start.toISOString()).toBe('2026-01-31T12:00:00.000Z');
      expect(february.end.toISOString()).toBe('2026-02-28T12:00:00.000Z');
    });

    /**
     * And the reason it is always recomputed from the anchor. March's window
     * starts on the 31st again — iterating from February's clamped 28th would
     * have lost those three days permanently, and lost more every year.
     */
    it('recovers the anchor day after a clamped month', async () => {
      await anchorAt(TENANT_A, '2026-01-31T12:00:00.000Z');

      const march = await inTenant(TENANT_A, (tx) =>
        periods.resolve(tx, TENANT_A, new Date('2026-04-01T00:00:00.000Z')),
      );

      expect(march.start.toISOString()).toBe('2026-03-31T12:00:00.000Z');
    });

    /** Branch 1: a subscription with both bounds set wins over the anchor. */
    it('prefers the subscription period once there is one', async () => {
      const plan = await systemPrisma.plan.upsert({
        where: { key: 'tar405-cap-plan' },
        create: {
          key: 'tar405-cap-plan',
          name: 'TAR-405 cap fixture',
          priceMinorUnits: 0,
          entitlements: entitlementsWithCap(null),
        },
        update: {},
        select: { id: true },
      });

      await systemPrisma.subscription.create({
        data: {
          tenantId: TENANT_A,
          planId: plan.id,
          currentPeriodStart: new Date('2026-03-01T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-04-01T00:00:00.000Z'),
        },
      });

      try {
        const period = await inTenant(TENANT_A, (tx) =>
          periods.resolve(tx, TENANT_A, new Date('2026-03-15T00:00:00.000Z')),
        );

        expect(period.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
      } finally {
        await systemPrisma.subscription.deleteMany({ where: { tenantId: TENANT_A } });
      }
    });

    /**
     * Half a subscription must not contribute half a window. A row with a start
     * and no end is what a partially-synced provider webhook leaves behind, and
     * pairing its start with the anchor's end would produce a window neither
     * source agrees with.
     */
    it('ignores a subscription that has only one of its two bounds', async () => {
      const plan = await systemPrisma.plan.upsert({
        where: { key: 'tar405-cap-plan' },
        create: {
          key: 'tar405-cap-plan',
          name: 'TAR-405 cap fixture',
          priceMinorUnits: 0,
          entitlements: entitlementsWithCap(null),
        },
        update: {},
        select: { id: true },
      });

      await systemPrisma.subscription.create({
        data: {
          tenantId: TENANT_A,
          planId: plan.id,
          currentPeriodStart: new Date('2026-03-01T00:00:00.000Z'),
          currentPeriodEnd: null,
        },
      });

      try {
        const period = await inTenant(TENANT_A, (tx) =>
          periods.resolve(tx, TENANT_A, new Date('2026-03-15T00:00:00.000Z')),
        );

        expect(period.start.toISOString()).toBe('2026-03-10T09:00:00.000Z');
      } finally {
        await systemPrisma.subscription.deleteMany({ where: { tenantId: TENANT_A } });
      }
    });
  });

  describe('the counter', () => {
    it('accumulates into one row per period', async () => {
      await inTenant(TENANT_A, async (tx) => {
        await usage.increment(tx, { tenantId: TENANT_A, metric: 'conversations_opened' });
        await usage.increment(tx, { tenantId: TENANT_A, metric: 'conversations_opened' });
      });

      const rows = await systemPrisma.usageCounter.findMany({
        where: { tenantId: TENANT_A, metric: 'conversations_opened' },
        select: { value: true },
      });

      expect(rows).toEqual([{ value: 2n }]);
    });

    /** Two periods are two rows, which is what makes an allowance reset. */
    it('starts a new row in the next period', async () => {
      await inTenant(TENANT_A, async (tx) => {
        await usage.increment(tx, {
          tenantId: TENANT_A,
          metric: 'conversations_opened',
          at: new Date('2026-02-15T00:00:00.000Z'),
        });
        await usage.increment(tx, {
          tenantId: TENANT_A,
          metric: 'conversations_opened',
          at: new Date('2026-03-15T00:00:00.000Z'),
        });
      });

      await expect(
        systemPrisma.usageCounter.count({ where: { tenantId: TENANT_A } }),
      ).resolves.toBe(2);
    });

    it('reads zero for a period nothing has happened in', async () => {
      const { value } = await inTenant(TENANT_A, (tx) =>
        usage.current(tx, { tenantId: TENANT_A, metric: 'conversations_opened' }),
      );

      expect(value).toBe(0);
    });

    /** A rolled-back transaction must take its increment with it — `usage.ts`'s rule. */
    it('does not survive a rollback of the transaction that caused it', async () => {
      await expect(
        inTenant(TENANT_A, async (tx) => {
          await usage.increment(tx, { tenantId: TENANT_A, metric: 'conversations_opened' });

          throw new Error('the write that caused this failed');
        }),
      ).rejects.toThrow('the write that caused this failed');

      await expect(
        systemPrisma.usageCounter.count({ where: { tenantId: TENANT_A } }),
      ).resolves.toBe(0);
    });
  });

  describe('the refusal', () => {
    async function open(tenantId: string, times: number): Promise<void> {
      await inTenant(tenantId, async (tx) => {
        for (let n = 0; n < times; n += 1) {
          await usage.increment(tx, { tenantId, metric: 'conversations_opened' });
        }
      });
    }

    it('allows a send while the tenant is under its allowance', async () => {
      await open(TENANT_A, CAP - 1);

      await expect(
        inTenant(TENANT_A, (tx) => planLimits.assertConversationVolumeAvailable(tx, TENANT_A)),
      ).resolves.toBeUndefined();
    });

    it('refuses the send once the allowance is spent', async () => {
      await open(TENANT_A, CAP);

      await expect(
        inTenant(TENANT_A, (tx) => planLimits.assertConversationVolumeAvailable(tx, TENANT_A)),
      ).rejects.toThrow(PlanLimitExceededError);
    });

    it('reports the limit and the usage, so a console can say which ceiling it was', async () => {
      await open(TENANT_A, CAP);

      const error = await inTenant(TENANT_A, (tx) =>
        planLimits.assertConversationVolumeAvailable(tx, TENANT_A),
      ).catch((thrown: unknown) => thrown);

      expect(error).toMatchObject({ limit: 'conversationsPerPeriod', cap: CAP, used: CAP });
    });

    /**
     * The isolation assertion. Tenant B fills its allowance; tenant A has the
     * same cap and an empty counter. If the count were not confined by RLS, A
     * would inherit B's usage and be refused a send it is entitled to.
     */
    it('counts only the tenant in scope', async () => {
      await open(TENANT_B, CAP);

      await expect(
        inTenant(TENANT_B, (tx) => planLimits.assertConversationVolumeAvailable(tx, TENANT_B)),
      ).rejects.toThrow(PlanLimitExceededError);
      await expect(
        inTenant(TENANT_A, (tx) => planLimits.assertConversationVolumeAvailable(tx, TENANT_A)),
      ).resolves.toBeUndefined();
    });

    it('allows the send when the tenant has no conversation cap', async () => {
      await systemPrisma.tenantEntitlements.update({
        where: { tenantId: TENANT_A },
        data: { entitlements: entitlementsWithCap(null) },
      });
      await open(TENANT_A, CAP + 5);

      await expect(
        inTenant(TENANT_A, (tx) => planLimits.assertConversationVolumeAvailable(tx, TENANT_A)),
      ).resolves.toBeUndefined();
    });

    /**
     * The allowance is per period, so last period's spend does not hold this one
     * shut. Written against the previous period explicitly rather than by waiting
     * a month.
     */
    it('lets a new period start with the allowance back', async () => {
      await inTenant(TENANT_A, async (tx) => {
        for (let n = 0; n < CAP; n += 1) {
          await usage.increment(tx, {
            tenantId: TENANT_A,
            metric: 'conversations_opened',
            at: new Date('2026-02-15T00:00:00.000Z'),
          });
        }
      });

      // `resolve` uses now() for the check, and the fixture's anchor is in the
      // past, so "now" is a later period than the one just filled.
      await expect(
        inTenant(TENANT_A, (tx) => planLimits.assertConversationVolumeAvailable(tx, TENANT_A)),
      ).resolves.toBeUndefined();
    });
  });
});

/**
 * The whole `PlanEntitlements` shape with one limit set, because
 * `tenant_entitlements_shape` refuses a partial one — the five limit keys must
 * all be present and each null or a positive integer.
 *
 * Used for `plans.entitlements` too, and deliberately the same helper: TAR-37's
 * billing contract copies a plan's entitlements straight into
 * `tenant_entitlements`, so the two columns take the identical shape and
 * `plans_entitlements_shape` asserts it on both sides of that copy. A fixture
 * that drifts apart from this helper is a fixture that stops representing what
 * the copy actually moves.
 *
 * The plan fixtures pass `null`: those rows exist only to give a `subscriptions`
 * row something to point at, and the cap under test comes from
 * `tenant_entitlements`, never from the plan.
 */
function entitlementsWithCap(conversationsPerPeriod: number | null): Prisma.InputJsonValue {
  return {
    features: [],
    limits: {
      seats: null,
      conversationsPerPeriod,
      whatsappNumbers: null,
      teams: null,
      knowledgeDocuments: null,
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
