import type { ConfigService } from '@nestjs/config';
import { PLAN_FEATURES } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { PlatformHostnameTakenError } from './tenant-provisioning.errors';
import { TenantProvisioningService } from './tenant-provisioning.service';

/**
 * Provisioning against a real PostgreSQL with TAR-48's policies applied — the
 * three properties TAR-19's first acceptance criterion asks for, none of which
 * a unit test can show:
 *
 *   * a provisioned tenant is **isolated**: its rows are visible under its own
 *     `tenant_id` through `TenantPrisma` and under no other;
 *   * provisioning is **idempotent**: a second run changes nothing;
 *   * provisioning **fails cleanly**: a failure part-way leaves no tenant row
 *     behind, so there is no half-provisioned tenant to clean up by hand.
 *
 * Each block owns its own slugs, so the file passes in any order and a failure
 * names one scenario rather than cascading through the rest.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Every fixture row
 * carries a `tar50-fixture` slug prefix and is removed before the run as well as
 * after it, so an interrupted run cleans up on the next one. Point `pnpm test:db`
 * at a local or disposable database.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const PLATFORM_DOMAIN = 'tar50.test';
const FIXTURE_PREFIX = 'tar50-fixture';

const SLUG_WRITES = `${FIXTURE_PREFIX}-writes`;
const SLUG_DEFAULTS = `${FIXTURE_PREFIX}-defaults`;
const SLUG_REPEAT = `${FIXTURE_PREFIX}-repeat`;
const SLUG_SQUATTED = `${FIXTURE_PREFIX}-squatted`;
const SLUG_SQUATTER = `${FIXTURE_PREFIX}-squatter`;
const SLUG_NEIGHBOUR_A = `${FIXTURE_PREFIX}-neighbour-a`;
const SLUG_NEIGHBOUR_B = `${FIXTURE_PREFIX}-neighbour-b`;

const REQUEST_ID = 'tar50-int-spec';

describe('tenant provisioning, end to end', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let provisioning: TenantProvisioningService;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null, principal: null },
      async () => await work(),
    );
  }

  async function removeFixture(): Promise<void> {
    // `tenant_settings` and `tenant_domains` cascade from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    provisioning = new TenantProvisioningService(systemPrisma, {
      getOrThrow: () => PLATFORM_DOMAIN,
    } as unknown as ConfigService);

    await removeFixture();
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  describe('what provisioning writes', () => {
    it('creates the tenant, its settings and its platform domain', async () => {
      const { tenant, created } = await provisioning.provision({
        slug: SLUG_WRITES,
        name: 'TAR-50 writes',
        timezone: 'Europe/London',
        locale: 'en-GB',
      });

      expect(created).toBe(true);
      expect(tenant).toMatchObject({
        slug: SLUG_WRITES,
        status: 'active',
        primaryHostname: `${SLUG_WRITES}.${PLATFORM_DOMAIN}`,
        timezone: 'Europe/London',
        locale: 'en-GB',
      });

      const stored = await systemPrisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: {
          status: true,
          settings: { select: { timezone: true, locale: true } },
          domains: { select: { hostname: true, kind: true, isPrimary: true, verifiedAt: true } },
        },
      });

      // Never observable as `created`: the row exists only once everything it
      // needs exists with it.
      expect(stored.status).toBe('active');
      expect(stored.settings).toEqual({ timezone: 'Europe/London', locale: 'en-GB' });
      expect(stored.domains).toHaveLength(1);

      const [domain] = stored.domains;

      expect(domain).toMatchObject({
        hostname: `${SLUG_WRITES}.${PLATFORM_DOMAIN}`,
        kind: 'platform',
        isPrimary: true,
      });
      // Ours to issue, under our own zone, so there is nothing to verify.
      expect(domain?.verifiedAt).toBeInstanceOf(Date);
    });

    it('seeds the schema defaults when the operator supplies none', async () => {
      const { tenant } = await provisioning.provision({
        slug: SLUG_DEFAULTS,
        name: 'TAR-50 defaults',
      });

      expect(tenant).toMatchObject({ timezone: 'UTC', locale: 'en' });
    });

    it('seeds the default SLA policy, readable by the tenant itself', async () => {
      const { tenant } = await provisioning.provision({
        slug: SLUG_DEFAULTS,
        name: 'TAR-50 defaults',
      });

      // Read through `TenantPrisma` rather than `SystemPrisma`: provisioning
      // writes this row unscoped, and what has to be true is that the tenant can
      // then see it under its own `app.tenant_id`. A row written with the wrong
      // `tenant_id` would still be found by the system client.
      const policies = await asTenant(tenant.id, () =>
        tenantPrisma.slaPolicy.findMany({
          select: {
            name: true,
            priority: true,
            firstResponseMinutes: true,
            resolutionMinutes: true,
            businessHoursOnly: true,
            isActive: true,
          },
        }),
      );

      expect(policies).toEqual([
        {
          name: 'Default',
          priority: null,
          firstResponseMinutes: 60,
          resolutionMinutes: null,
          businessHoursOnly: false,
          isActive: true,
        },
      ]);
    });

    /**
     * The seat cap reads a missing row as unlimited, which is the right answer
     * for a tenant nobody capped and the wrong thing to *rely* on: a limit whose
     * absence means "no limit" fails open silently the day a write is missed. So
     * every tenant carries an explicit answer, and an operator-provisioned one
     * says `unlimited` rather than inheriting the column's trial defaults.
     */
    it('writes an explicit unlimited entitlements row, readable by the tenant itself', async () => {
      const { tenant } = await provisioning.provision({
        slug: SLUG_DEFAULTS,
        name: 'TAR-50 defaults',
      });

      const rows = await asTenant(tenant.id, () =>
        tenantPrisma.tenantEntitlements.findMany({
          select: { planKey: true, planName: true, entitlements: true },
        }),
      );

      // Every one of the five limits, because `TenantLifecycleResponse.plan` is
      // served from this row and a partial one would not render (ADR 0009
      // Amendment 1 ruling 3).
      expect(rows).toEqual([
        {
          planKey: 'unlimited',
          planName: 'Unlimited',
          entitlements: {
            features: [...PLAN_FEATURES],
            limits: {
              seats: null,
              conversationsPerPeriod: null,
              whatsappNumbers: null,
              teams: null,
              knowledgeDocuments: null,
            },
          },
        },
      ]);
    });
  });

  describe('idempotency', () => {
    it('is a no-op on the second run, and reports the same tenant', async () => {
      const first = await provisioning.provision({ slug: SLUG_REPEAT, name: 'TAR-50 repeat' });
      const second = await provisioning.provision({ slug: SLUG_REPEAT, name: 'TAR-50 repeat' });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.tenant).toEqual(first.tenant);
    });

    it('does not rename a tenant that already exists', async () => {
      await provisioning.provision({ slug: SLUG_REPEAT, name: 'TAR-50 repeat' });

      const { tenant } = await provisioning.provision({
        slug: SLUG_REPEAT,
        name: 'Renamed By A Replayed Script',
      });

      expect(tenant.name).toBe('TAR-50 repeat');
    });

    it('creates exactly one settings row, one domain and one SLA policy however often it runs', async () => {
      for (let run = 0; run < 3; run += 1) {
        await provisioning.provision({ slug: SLUG_REPEAT, name: 'TAR-50 repeat' });
      }

      const where = { tenant: { slug: SLUG_REPEAT } };
      const [settings, domains, policies] = await Promise.all([
        systemPrisma.tenantSettings.count({ where }),
        systemPrisma.tenantDomain.count({ where }),
        systemPrisma.slaPolicy.count({ where }),
      ]);

      expect(settings).toBe(1);
      expect(domains).toBe(1);
      // Two would be worse than none: policy resolution prefers the ticket's own
      // priority and then falls back to `priority IS NULL`, so a duplicate
      // catch-all makes which window applies depend on `created_at`.
      expect(policies).toBe(1);
    });

    it('repairs a tenant that is missing its settings, its domain and its SLA policy', async () => {
      const { tenant } = await provisioning.provision({ slug: SLUG_REPEAT, name: 'TAR-50 repeat' });

      await systemPrisma.tenantSettings.deleteMany({ where: { tenantId: tenant.id } });
      await systemPrisma.tenantDomain.deleteMany({ where: { tenantId: tenant.id } });
      await systemPrisma.slaPolicy.deleteMany({ where: { tenantId: tenant.id } });
      await systemPrisma.tenantEntitlements.deleteMany({ where: { tenantId: tenant.id } });

      const repaired = await provisioning.provision({ slug: SLUG_REPEAT, name: 'TAR-50 repeat' });

      expect(repaired.created).toBe(false);
      expect(repaired.tenant.primaryHostname).toBe(`${SLUG_REPEAT}.${PLATFORM_DOMAIN}`);
      await expect(
        systemPrisma.tenantSettings.count({ where: { tenantId: tenant.id } }),
      ).resolves.toBe(1);
      await expect(systemPrisma.slaPolicy.count({ where: { tenantId: tenant.id } })).resolves.toBe(
        1,
      );
      // The tenant that predates this change, converging on the same shape as one
      // provisioned after it.
      await expect(
        systemPrisma.tenantEntitlements.count({ where: { tenantId: tenant.id } }),
      ).resolves.toBe(1);
    });

    /**
     * A tenant whose caps were set deliberately — by TAR-37's plan sync, or by an
     * operator — must not have them reset to `unlimited` by a replayed
     * provisioning script. Same rule as the SLA policy above: repair what is
     * missing, never reassert over what is there.
     */
    it('does not overwrite the caps of a tenant that already has them', async () => {
      const { tenant } = await provisioning.provision({ slug: SLUG_REPEAT, name: 'TAR-50 repeat' });

      const sold = {
        features: ['assignment_rules'],
        limits: {
          seats: 10,
          conversationsPerPeriod: 10_000,
          whatsappNumbers: 2,
          teams: 5,
          knowledgeDocuments: 50,
        },
      };

      await systemPrisma.tenantEntitlements.update({
        where: { tenantId: tenant.id },
        data: { planKey: 'growth', planName: 'Growth', entitlements: sold },
      });

      await provisioning.provision({ slug: SLUG_REPEAT, name: 'TAR-50 repeat' });

      await expect(
        systemPrisma.tenantEntitlements.findUnique({
          where: { tenantId: tenant.id },
          select: { planKey: true, planName: true, entitlements: true },
        }),
      ).resolves.toEqual({ planKey: 'growth', planName: 'Growth', entitlements: sold });
    });

    it('does not add a second policy to a tenant that configured its own', async () => {
      const { tenant } = await provisioning.provision({ slug: SLUG_REPEAT, name: 'TAR-50 repeat' });

      await systemPrisma.slaPolicy.deleteMany({ where: { tenantId: tenant.id } });
      await systemPrisma.slaPolicy.create({
        data: {
          tenantId: tenant.id,
          name: 'Gold',
          priority: 'urgent',
          firstResponseMinutes: 15,
        },
      });

      await provisioning.provision({ slug: SLUG_REPEAT, name: 'TAR-50 repeat' });

      const policies = await systemPrisma.slaPolicy.findMany({
        where: { tenantId: tenant.id },
        select: { name: true },
      });

      expect(policies).toEqual([{ name: 'Gold' }]);
    });
  });

  describe('failing cleanly', () => {
    it('rolls the whole thing back when the platform hostname belongs to someone else', async () => {
      // Another tenant already holds the host this slug maps to — the shape of
      // a custom domain (TAR-29) registered before the slug was provisioned.
      //
      // The token is not what this case is about, but every custom domain
      // carries one: `tenant_domains_custom_needs_token` (TAR-417) makes a
      // tokenless custom row unrepresentable, because nothing could ever verify
      // it by DNS challenge. Thirty-two lowercase hex characters, per the format
      // constraint beside it.
      const squatter = await systemPrisma.tenant.create({
        data: {
          slug: SLUG_SQUATTER,
          name: 'TAR-50 squatter',
          status: 'active',
          domains: {
            create: {
              hostname: `${SLUG_SQUATTED}.${PLATFORM_DOMAIN}`,
              kind: 'custom',
              verificationToken: '50505050505050505050505050505050',
            },
          },
        },
        select: { id: true },
      });

      await expect(
        provisioning.provision({ slug: SLUG_SQUATTED, name: 'TAR-50 squatted' }),
      ).rejects.toBeInstanceOf(PlatformHostnameTakenError);

      // No tenant row, so nothing half-provisioned is left for an operator to
      // find later — and the tenant that owned the hostname is untouched.
      await expect(systemPrisma.tenant.count({ where: { slug: SLUG_SQUATTED } })).resolves.toBe(0);
      await expect(
        systemPrisma.tenantDomain.count({
          where: { hostname: `${SLUG_SQUATTED}.${PLATFORM_DOMAIN}`, tenantId: squatter.id },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('the provisioned tenant is isolated', () => {
    let neighbourA: string;
    let neighbourB: string;

    beforeAll(async () => {
      neighbourA = (
        await provisioning.provision({ slug: SLUG_NEIGHBOUR_A, name: 'TAR-50 neighbour A' })
      ).tenant.id;
      neighbourB = (
        await provisioning.provision({ slug: SLUG_NEIGHBOUR_B, name: 'TAR-50 neighbour B' })
      ).tenant.id;
    });

    it('shows each tenant only its own settings, through TenantPrisma', async () => {
      const seenByA = await asTenant(neighbourA, () =>
        tenantPrisma.tenantSettings.findMany({ select: { tenantId: true } }),
      );

      expect(seenByA).toEqual([{ tenantId: neighbourA }]);
    });

    it('shows each tenant only its own domains', async () => {
      const seenByB = await asTenant(neighbourB, () =>
        tenantPrisma.tenantDomain.findMany({ select: { hostname: true } }),
      );

      expect(seenByB).toEqual([{ hostname: `${SLUG_NEIGHBOUR_B}.${PLATFORM_DOMAIN}` }]);
    });

    it('returns nothing when one tenant asks for its neighbour by id', async () => {
      const stolen = await asTenant(neighbourA, () =>
        tenantPrisma.tenantSettings.findUnique({
          where: { tenantId: neighbourB },
          select: { tenantId: true },
        }),
      );

      expect(stolen).toBeNull();
    });

    it('shows a tenant only its own record, not the one provisioned next to it', async () => {
      const visible = await asTenant(neighbourA, () =>
        tenantPrisma.tenant.findMany({
          where: { slug: { startsWith: FIXTURE_PREFIX } },
          select: { id: true },
        }),
      );

      expect(visible).toEqual([{ id: neighbourA }]);
    });

    it('lets the new tenant write its own data immediately, invisibly to the other', async () => {
      const contact = await asTenant(neighbourA, () =>
        tenantPrisma.contact.create({
          data: { tenantId: neighbourA, phoneE164: '+10000005001' },
          select: { id: true },
        }),
      );

      const seenByB = await asTenant(neighbourB, () =>
        tenantPrisma.contact.findUnique({ where: { id: contact.id }, select: { id: true } }),
      );

      expect(seenByB).toBeNull();

      await asTenant(neighbourA, () => tenantPrisma.contact.delete({ where: { id: contact.id } }));
    });
  });
});

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
