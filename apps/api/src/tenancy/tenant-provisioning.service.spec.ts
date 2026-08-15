import type { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client';
import type { SystemPrisma } from '../prisma/prisma.tokens';
import { PlatformHostnameTakenError, TenantSlugTakenError } from './tenant-provisioning.errors';
import { TenantProvisioningService } from './tenant-provisioning.service';

/**
 * What the service composes, with no database in the way: which statements it
 * issues, in what order, and what it refuses to overwrite. That the statements
 * have the effect they are there for — atomicity, isolation, a real unique
 * index — is `tenant-provisioning.int-spec.ts`, against a real PostgreSQL.
 */

const PLATFORM_DOMAIN = 'app.example.com';
const TENANT_ID = '50444444-4444-7444-8444-444444444401';
const CREATED_AT = new Date('2026-08-10T09:00:00.000Z');

/** Just the parts of `tenant.create`'s argument these assertions read. */
interface TenantCreateArgs {
  data: {
    slug: string;
    name: string;
    status: string;
    settings: { create: { timezone: string; locale: string } };
    domains: { create: { hostname: string; kind: string; isPrimary: boolean } };
    slaPolicies: {
      create: {
        name: string;
        priority: string | null;
        firstResponseMinutes: number;
        resolutionMinutes: number | null;
        businessHoursOnly: boolean;
        isActive: boolean;
      };
    };
    planLimits: {
      create: { planKey: string; seatCap: number | null; conversationCap: number | null };
    };
  };
}

interface TransactionSpies {
  $executeRaw: jest.Mock;
  tenant: { findUnique: jest.Mock; create: jest.Mock };
  tenantSettings: { create: jest.Mock };
  tenantDomain: { create: jest.Mock };
  slaPolicy: { create: jest.Mock };
  tenantPlanLimits: { create: jest.Mock };
}

describe('TenantProvisioningService', () => {
  let tx: TransactionSpies;
  let service: TenantProvisioningService;

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      tenant: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      tenantSettings: { create: jest.fn() },
      tenantDomain: { create: jest.fn() },
      slaPolicy: { create: jest.fn() },
      tenantPlanLimits: { create: jest.fn() },
    };

    const systemPrisma = {
      $transaction: jest.fn(async (work: (client: TransactionSpies) => Promise<unknown>) =>
        work(tx),
      ),
    } as unknown as SystemPrisma;

    const config = { getOrThrow: () => PLATFORM_DOMAIN } as unknown as ConfigService;

    service = new TenantProvisioningService(systemPrisma, config);
  });

  /** The argument the service passed to `tenant.create`, typed. */
  function tenantCreateArgs(): TenantCreateArgs {
    const [firstCall] = tx.tenant.create.mock.calls as [TenantCreateArgs][];

    if (firstCall === undefined) {
      throw new Error('tenant.create was never called');
    }

    return firstCall[0];
  }

  describe('a slug that has never been provisioned', () => {
    beforeEach(() => {
      tx.tenant.create.mockResolvedValue({
        id: TENANT_ID,
        slug: 'acme',
        name: 'Acme Ltd',
        status: 'active',
        createdAt: CREATED_AT,
      });
    });

    it('creates the tenant, its settings and its platform domain in one statement', async () => {
      const result = await service.provision({ slug: 'acme', name: 'Acme Ltd' });

      expect(result.created).toBe(true);
      expect(tx.tenant.create).toHaveBeenCalledTimes(1);

      const { data } = tenantCreateArgs();

      expect(data).toMatchObject({ slug: 'acme', name: 'Acme Ltd', status: 'active' });
      // Nested, so a failure on any child rolls the tenant back with it.
      expect(data.settings.create).toMatchObject({ timezone: 'UTC', locale: 'en' });
      expect(data.domains.create).toMatchObject({
        hostname: 'acme.app.example.com',
        kind: 'platform',
        isPrimary: true,
      });
    });

    it('seeds the default SLA policy, as the catch-all for any priority', async () => {
      await service.provision({ slug: 'acme', name: 'Acme Ltd' });

      const { data } = tenantCreateArgs();

      // Nested with the other two, so a tenant never exists without the policy
      // its first ticket's timer resolves against (0006, decision 6). `priority`
      // null is the catch-all; a null `resolutionMinutes` is what keeps v1 to
      // the first-response timer only.
      expect(data.slaPolicies.create).toEqual({
        name: 'Default',
        priority: null,
        firstResponseMinutes: 60,
        resolutionMinutes: null,
        businessHoursOnly: false,
        isActive: true,
      });
      // Written with the tenant, never as a follow-up statement.
      expect(tx.slaPolicy.create).not.toHaveBeenCalled();
    });

    it('seeds an uncapped plan-limits row, so the seat check has something to read', async () => {
      await service.provision({ slug: 'acme', name: 'Acme Ltd' });

      const { data } = tenantCreateArgs();

      // Both caps null rather than inherited from the column defaults, which
      // are the trial's. An operator-provisioned tenant was never sold a cap,
      // and `plan_key` is what makes these rows findable when TAR-37's plan
      // sync becomes this table's writer.
      expect(data.planLimits.create).toEqual({
        planKey: 'unlimited',
        seatCap: null,
        conversationCap: null,
      });
      // Nested with the tenant: `PlanLimitsService` reads a missing row as
      // unlimited, so a row written in a second statement that could fail on
      // its own would be a tenant the seat cap silently never applies to.
      expect(tx.tenantPlanLimits.create).not.toHaveBeenCalled();
    });

    it('derives the hostname from the slug, never from the caller', async () => {
      const result = await service.provision({ slug: 'acme', name: 'Acme Ltd' });

      expect(result.tenant.primaryHostname).toBe('acme.app.example.com');
    });

    it('seeds the settings the operator asked for', async () => {
      const result = await service.provision({
        slug: 'acme',
        name: 'Acme Ltd',
        timezone: 'Europe/London',
        locale: 'en-GB',
      });

      const { data } = tenantCreateArgs();

      expect(result.tenant).toMatchObject({ timezone: 'Europe/London', locale: 'en-GB' });
      expect(data.settings.create).toEqual({ timezone: 'Europe/London', locale: 'en-GB' });
    });

    it('takes the advisory lock before it looks the slug up', async () => {
      await service.provision({ slug: 'acme', name: 'Acme Ltd' });

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);

      // The fallbacks make a spy that was never called fail the comparison,
      // rather than needing a non-null assertion to satisfy the compiler.
      const lockedAt = tx.$executeRaw.mock.invocationCallOrder.at(0) ?? Number.POSITIVE_INFINITY;
      const readAt =
        tx.tenant.findUnique.mock.invocationCallOrder.at(0) ?? Number.NEGATIVE_INFINITY;

      expect(lockedAt).toBeLessThan(readAt);

      // The lock key is namespaced and carries the slug, so two different
      // tenants do not serialise behind each other.
      const [, lockKey] = tx.$executeRaw.mock.calls[0] as [TemplateStringsArray, string];
      expect(lockKey).toBe('tenant-provisioning:acme');
    });
  });

  describe('a slug that is already provisioned', () => {
    beforeEach(() => {
      tx.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: 'acme',
        name: 'Acme Ltd',
        status: 'suspended',
        createdAt: CREATED_AT,
        settings: { timezone: 'Europe/London', locale: 'en-GB' },
        domains: [{ hostname: 'acme.app.example.com' }],
        slaPolicies: [{ id: 'e1444444-4444-7444-8444-444444444490' }],
        planLimits: { id: 'e2444444-4444-7444-8444-444444444490' },
      });
    });

    it('is a no-op that reports the tenant as it stands', async () => {
      const result = await service.provision({ slug: 'acme', name: 'Acme Ltd' });

      expect(result.created).toBe(false);
      expect(result.tenant).toEqual({
        id: TENANT_ID,
        slug: 'acme',
        name: 'Acme Ltd',
        status: 'suspended',
        createdAt: CREATED_AT,
        primaryHostname: 'acme.app.example.com',
        timezone: 'Europe/London',
        locale: 'en-GB',
      });
      expect(tx.tenant.create).not.toHaveBeenCalled();
      expect(tx.tenantSettings.create).not.toHaveBeenCalled();
      expect(tx.tenantDomain.create).not.toHaveBeenCalled();
      expect(tx.slaPolicy.create).not.toHaveBeenCalled();
    });

    it('does not rename it, and does not reset its settings, to match the request', async () => {
      // A replayed script must not be able to rename a live tenant or move its
      // business hours; that is `PATCH /tenant`, and TAR-36 owns the status.
      const result = await service.provision({
        slug: 'acme',
        name: 'Something Else',
        timezone: 'Asia/Riyadh',
        locale: 'ar',
      });

      expect(result.tenant).toMatchObject({
        name: 'Acme Ltd',
        status: 'suspended',
        timezone: 'Europe/London',
        locale: 'en-GB',
      });
    });
  });

  describe('a tenant that is missing part of its provisioning', () => {
    it('adds only what is absent', async () => {
      tx.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: 'acme',
        name: 'Acme Ltd',
        status: 'active',
        createdAt: CREATED_AT,
        settings: null,
        domains: [],
        slaPolicies: [],
        planLimits: null,
      });
      tx.tenantSettings.create.mockResolvedValue({ timezone: 'UTC', locale: 'en' });
      tx.tenantDomain.create.mockResolvedValue({ hostname: 'acme.app.example.com' });

      const result = await service.provision({ slug: 'acme', name: 'Acme Ltd' });

      expect(result.created).toBe(false);
      expect(tx.tenantSettings.create).toHaveBeenCalledTimes(1);
      expect(tx.tenantDomain.create).toHaveBeenCalledTimes(1);
      // A tenant provisioned before TAR-270 converges on the same shape as one
      // provisioned after it, rather than waiting for TAR-280's lazy creation.
      expect(tx.slaPolicy.create).toHaveBeenCalledTimes(1);
      // Same convergence for the tenants provisioned between TAR-403's backfill
      // and this change, which have no row at all and so read as unlimited.
      expect(tx.tenantPlanLimits.create).toHaveBeenCalledWith({
        data: {
          tenantId: TENANT_ID,
          planKey: 'unlimited',
          seatCap: null,
          conversationCap: null,
        },
        select: { id: true },
      });
      expect(result.tenant).toMatchObject({
        timezone: 'UTC',
        locale: 'en',
        primaryHostname: 'acme.app.example.com',
      });
    });

    it('leaves a tenant that already configured its own SLA policy alone', async () => {
      // Not keyed on the name `Default`: a tenant whose only policy is called
      // "Gold" has configured one, and a second row would silently become the
      // catch-all the resolver falls back to (0006, decision 6).
      tx.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: 'acme',
        name: 'Acme Ltd',
        status: 'active',
        createdAt: CREATED_AT,
        settings: { timezone: 'UTC', locale: 'en' },
        domains: [{ hostname: 'acme.app.example.com' }],
        slaPolicies: [{ id: 'e1444444-4444-7444-8444-444444444491' }],
        planLimits: { id: 'e2444444-4444-7444-8444-444444444491' },
      });

      await service.provision({ slug: 'acme', name: 'Acme Ltd' });

      expect(tx.slaPolicy.create).not.toHaveBeenCalled();
    });

    it('leaves the plan limits of a tenant that already has a row alone', async () => {
      // The one that matters most: a replayed provisioning call against a
      // tenant on a paid plan must not reset its caps to `unlimited`. Presence
      // is the whole test — this service does not read what the row says.
      tx.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: 'acme',
        name: 'Acme Ltd',
        status: 'active',
        createdAt: CREATED_AT,
        settings: { timezone: 'UTC', locale: 'en' },
        domains: [{ hostname: 'acme.app.example.com' }],
        slaPolicies: [{ id: 'e1444444-4444-7444-8444-444444444493' }],
        planLimits: { id: 'e2444444-4444-7444-8444-444444444493' },
      });

      await service.provision({ slug: 'acme', name: 'Acme Ltd' });

      expect(tx.tenantPlanLimits.create).not.toHaveBeenCalled();
    });

    it('keeps an existing platform domain even when PLATFORM_DOMAIN has moved on', async () => {
      tx.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: 'acme',
        name: 'Acme Ltd',
        status: 'active',
        createdAt: CREATED_AT,
        settings: { timezone: 'UTC', locale: 'en' },
        domains: [{ hostname: 'acme.old-platform.example.com' }],
        slaPolicies: [{ id: 'e1444444-4444-7444-8444-444444444492' }],
        planLimits: { id: 'e2444444-4444-7444-8444-444444444492' },
      });

      const result = await service.provision({ slug: 'acme', name: 'Acme Ltd' });

      expect(result.tenant.primaryHostname).toBe('acme.old-platform.example.com');
      expect(tx.tenantDomain.create).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    /**
     * The two spellings of a unique violation the client can produce.
     * `@prisma/adapter-pg` — the driver this application actually uses —
     * leaves `meta.target` undefined and carries Postgres's own message
     * instead, so both are exercised rather than assumed equivalent.
     */
    function uniqueViolation(constraint: string, driverShape: boolean) {
      return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
        meta: driverShape
          ? {
              modelName: 'Tenant',
              driverAdapterError: {
                name: 'DriverAdapterError',
                cause: {
                  kind: 'UniqueConstraintViolation',
                  originalCode: '23505',
                  originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
                },
              },
            }
          : { target: [constraint] },
      });
    }

    it.each([true, false])(
      'reports a hostname claimed by another tenant as such (driver shape: %s)',
      async (driverShape) => {
        tx.tenant.create.mockRejectedValue(
          uniqueViolation('tenant_domains_hostname_key', driverShape),
        );

        await expect(service.provision({ slug: 'acme', name: 'Acme Ltd' })).rejects.toBeInstanceOf(
          PlatformHostnameTakenError,
        );
      },
    );

    it('reports a slug inserted by another writer as a conflict, not a fault', async () => {
      tx.tenant.create.mockRejectedValue(uniqueViolation('tenants_slug_key', true));

      await expect(service.provision({ slug: 'acme', name: 'Acme Ltd' })).rejects.toBeInstanceOf(
        TenantSlugTakenError,
      );
    });

    it('leaves anything else untranslated, so a fault is logged as a fault', async () => {
      tx.tenant.create.mockRejectedValue(new Error('connection terminated unexpectedly'));

      await expect(service.provision({ slug: 'acme', name: 'Acme Ltd' })).rejects.toThrow(
        'connection terminated unexpectedly',
      );
    });
  });
});
