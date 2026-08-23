import type { ConfigService } from '@nestjs/config';
import { permissionsForRole, type SessionPrincipal, type TenantRole } from '@whatsappcrm/contracts';
import type { AuditService } from '../../audit/audit.service';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import type { Prisma } from '../../generated/prisma/client';
import type { TenantPrisma } from '../../prisma/prisma.tokens';
import { DomainNotActivatedError, DomainNotVerifiedError } from '../tenancy.errors';
import type { DomainOwnershipChecker } from './domain-ownership.checker';
import { TenantDomainsService } from './tenant-domains.service';
import type { TenantDomainRow } from './tenant-domain.mapper';

/**
 * The two decisions this service makes before it touches the database: who may
 * see the DNS challenge, and which domains may become the tenant's main address.
 *
 * The database is stubbed. That RLS actually scopes the reads, and that the
 * global unique index on `hostname` settles a race between two tenants, are
 * properties of PostgreSQL and are proved in `branding-domains-api.int-spec.ts`.
 */

const TENANT_ID = '42000000-0000-7000-8000-0000000004a1';
const USER_ID = '42000000-0000-7000-8000-0000000004a2';
const PLATFORM_ID = '42000000-0000-7000-8000-0000000004b1';
const CUSTOM_ID = '42000000-0000-7000-8000-0000000004b2';

const NOW = new Date('2026-08-16T09:00:00.000Z');

function row(overrides: Partial<TenantDomainRow> = {}): TenantDomainRow {
  return {
    id: CUSTOM_ID,
    hostname: 'support.acme.example',
    kind: 'custom',
    isPrimary: false,
    verifiedAt: null,
    activatedAt: null,
    verificationToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    verificationRequestedAt: NOW,
    verificationLastCheckedAt: null,
    verificationFailureReason: null,
    createdAt: NOW,
    ...overrides,
  };
}

/** The tenant's platform subdomain: verified at provisioning, never activated. */
const PLATFORM_ROW = row({
  id: PLATFORM_ID,
  hostname: 'acme.app.localhost',
  kind: 'platform',
  isPrimary: true,
  verifiedAt: NOW,
  verificationToken: null,
  verificationRequestedAt: null,
});

function principal(role: TenantRole): SessionPrincipal {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    email: `${role}@acme.example`,
    displayName: role,
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: '42000000-0000-7000-8000-0000000004c1',
    expiresAt: '2026-08-17T09:00:00.000Z',
  };
}

describe('TenantDomainsService', () => {
  let rows: TenantDomainRow[];
  let updateMany: jest.Mock;
  let update: jest.Mock;
  let tenantContext: TenantContextService;
  let service: TenantDomainsService;

  /**
   * The clock is frozen at `NOW`, the same way `tenant-domain.mapper.spec.ts`
   * freezes it and for the same reason: the status these cases assert is derived
   * from the fixture's `expiresAt` against the current time, not stored. Left on
   * the real clock, the pending domain below turned `expired` on 2026-08-17 and
   * every run after that date failed on a fixture that had simply aged out.
   */
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    rows = [PLATFORM_ROW, row()];
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    update = jest
      .fn()
      .mockImplementation(({ where, data }: { where: { id: string }; data: { isPrimary: true } }) =>
        Promise.resolve({ ...(rows.find((item) => item.id === where.id) ?? row()), ...data }),
      );

    const tx = {
      tenantDomain: { updateMany, update },
    } as unknown as Prisma.TransactionClient;

    const prisma = {
      tenantDomain: {
        findMany: jest.fn().mockImplementation(() => Promise.resolve(rows)),
        findFirst: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) =>
            Promise.resolve(rows.find((item) => item.id === where.id) ?? null),
          ),
      },
      $tenantTransaction: (work: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        work(tx),
    } as unknown as TenantPrisma;

    tenantContext = new TenantContextService();
    service = new TenantDomainsService(
      prisma,
      {} as unknown as DomainOwnershipChecker,
      {} as unknown as AuditService,
      tenantContext,
      {
        get: () => 'whatsappcrm-web.onrender.invalid',
        getOrThrow: (key: string) => (key === 'PLATFORM_DOMAIN' ? 'app.localhost' : 7),
      } as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function as<T>(role: TenantRole, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      {
        requestId: 'req_domains_spec',
        tenantId: TENANT_ID,
        userId: USER_ID,
        principal: principal(role),
      },
      work,
    );
  }

  describe('listForCaller', () => {
    it('withholds the challenge from a caller who could not read it on /tenant/domains', async () => {
      // `GET /api/v1/tenant` is open to every signed-in member, and it used to
      // compose the full rows — handing an agent the pending verification tokens
      // that `domain:write` exists to gate one route over.
      const listed = await as('agent', () => service.listForCaller());

      expect(permissionsForRole('agent')).not.toContain('domain:write');
      expect(listed.map((domain) => domain.verification)).toEqual([null, null]);
      expect(listed.map((domain) => domain.routing)).toEqual([null, null]);
      expect(JSON.stringify(listed)).not.toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    });

    it('still says which hostnames the tenant answers on, which is what the shell renders', async () => {
      const listed = await as('agent', () => service.listForCaller());

      expect(listed).toEqual([
        expect.objectContaining({ hostname: 'acme.app.localhost', isPrimary: true }),
        expect.objectContaining({
          hostname: 'support.acme.example',
          status: 'pending_verification',
        }),
      ]);
    });

    it('hands an admin the whole row, so the settings screen sees one truth', async () => {
      const listed = await as('admin', () => service.listForCaller());

      expect(permissionsForRole('admin')).toContain('domain:write');
      expect(listed[1]?.verification?.recordValue).toBe(
        'whatsappcrm-domain-verification=a1b2c3d4e5f60718293a4b5c6d7e8f90',
      );
      expect(listed).toEqual(await as('admin', () => service.list()));
    });
  });

  describe('setPrimary', () => {
    it('refuses a claim nobody has proved', async () => {
      await expect(as('admin', () => service.setPrimary(CUSTOM_ID))).rejects.toBeInstanceOf(
        DomainNotVerifiedError,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses a proved domain the edge is not serving yet', async () => {
      // Invite and password-reset links are mailed to the primary. Attaching the
      // hostname at the edge is a manual operator step that can be hours behind
      // verification, and inside that window the mail sends to a host with no
      // route and no certificate — silently, from our side.
      rows = [PLATFORM_ROW, row({ verifiedAt: NOW })];

      await expect(as('admin', () => service.setPrimary(CUSTOM_ID))).rejects.toBeInstanceOf(
        DomainNotActivatedError,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('promotes it once the edge is serving it', async () => {
      rows = [PLATFORM_ROW, row({ verifiedAt: NOW, activatedAt: NOW })];

      await expect(as('admin', () => service.setPrimary(CUSTOM_ID))).resolves.toMatchObject({
        hostname: 'support.acme.example',
        isPrimary: true,
      });
      // The old primary is cleared first: `tenant_domains_one_primary` is a
      // unique index, so the two statements cannot be reordered.
      expect(updateMany).toHaveBeenCalledWith({
        where: { isPrimary: true },
        data: { isPrimary: false },
      });
    });

    it('asks no activation of the platform subdomain, which never has one', async () => {
      // It is served by the same edge as every other tenant's, so it is
      // deliverable the moment it exists — and it is where `remove()` puts
      // primary back, so an unpromotable one would strand the tenant.
      rows = [
        { ...PLATFORM_ROW, isPrimary: false },
        row({ verifiedAt: NOW, activatedAt: NOW, isPrimary: true }),
      ];

      await expect(as('admin', () => service.setPrimary(PLATFORM_ID))).resolves.toMatchObject({
        hostname: 'acme.app.localhost',
        isPrimary: true,
        activatedAt: null,
      });
    });
  });
});
