import { Logger } from '@nestjs/common';
import { AUDIT_ACTIONS } from '../../audit/audit.actions';
import type { AuditService } from '../../audit/audit.service';
import type { Prisma } from '../../generated/prisma/client';
import type { SystemPrisma, TenantPrisma } from '../../prisma/prisma.tokens';
import { TenantDomainNotFoundError } from '../tenancy.errors';
import { AdminDomainsService } from './admin-domains.service';

/**
 * What deactivation does to `is_primary` (TAR-534).
 *
 * `TenantDomainsService.setPrimary()` refuses to promote a domain the edge is
 * not serving; until this fix, detaching one left the flag exactly where the
 * promotion path forbids it — and `TenantLinkService.primaryHostname()` mails
 * invite and password-reset tokens to whatever that flag names. The interesting
 * assertions below are about *ordering* as much as outcome: the old primary has
 * to be cleared before the fallback is set or the second write collides with
 * `tenant_domains_one_primary`.
 *
 * The database is stubbed with a tiny in-memory table, so a case can assert on
 * the rows rather than on the calls that produced them. That the unique index
 * actually exists and rejects a second primary is PostgreSQL's, and is proved in
 * `prisma/tenant-branding-domains.int-spec.ts`; that the whole path holds
 * against a real one is `branding-domains-api.int-spec.ts`.
 */

const PLATFORM_ID = '43400000-0000-7000-8000-000000000501';
const CUSTOM_ID = '43400000-0000-7000-8000-000000000502';

const PLATFORM_HOST = 'acme.app.localhost';
const CUSTOM_HOST = 'support.acme.example';

const VERIFIED_AT = new Date('2026-08-16T09:00:00.000Z');
const ACTIVATED_AT = new Date('2026-08-16T10:00:00.000Z');

interface DomainRow {
  id: string;
  hostname: string;
  kind: 'platform' | 'custom';
  isPrimary: boolean;
  verifiedAt: Date | null;
  activatedAt: Date | null;
  createdAt: Date;
}

function platformRow(overrides: Partial<DomainRow> = {}): DomainRow {
  return {
    id: PLATFORM_ID,
    hostname: PLATFORM_HOST,
    kind: 'platform',
    isPrimary: false,
    verifiedAt: VERIFIED_AT,
    activatedAt: null,
    createdAt: VERIFIED_AT,
    ...overrides,
  };
}

function customRow(overrides: Partial<DomainRow> = {}): DomainRow {
  return {
    id: CUSTOM_ID,
    hostname: CUSTOM_HOST,
    kind: 'custom',
    isPrimary: false,
    verifiedAt: VERIFIED_AT,
    activatedAt: ACTIVATED_AT,
    createdAt: ACTIVATED_AT,
    ...overrides,
  };
}

/** The subset of a Prisma `where` this service actually builds. */
interface DomainWhere {
  hostname?: string;
  kind?: 'platform' | 'custom';
  verifiedAt?: { not: null };
}

function matches(row: DomainRow, where: DomainWhere): boolean {
  if (where.hostname !== undefined && row.hostname !== where.hostname) {
    return false;
  }

  if (where.kind !== undefined && row.kind !== where.kind) {
    return false;
  }

  return where.verifiedAt === undefined || row.verifiedAt !== null;
}

describe('AdminDomainsService', () => {
  let rows: DomainRow[];
  /** Every `update`, in the order it was issued — the collision is an ordering bug. */
  let updates: { id: string; data: Partial<DomainRow> }[];
  let record: jest.Mock;
  let warn: jest.SpyInstance;
  let service: AdminDomainsService;

  beforeEach(() => {
    rows = [platformRow({ isPrimary: true }), customRow()];
    updates = [];
    record = jest.fn().mockResolvedValue(undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const tx = {
      tenantDomain: {
        findFirst: ({ where }: { where: DomainWhere }) =>
          Promise.resolve(rows.find((row) => matches(row, where)) ?? null),
        update: ({ where, data }: { where: { id: string }; data: Partial<DomainRow> }) => {
          updates.push({ id: where.id, data });

          const row = rows.find((candidate) => candidate.id === where.id);

          if (row === undefined) {
            throw new Error(`unreachable: no fixture row ${where.id}`);
          }

          Object.assign(row, data);

          return Promise.resolve(row);
        },
      },
    } as unknown as Prisma.TransactionClient;

    const tenantPrisma = {
      $tenantTransaction: (work: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        work(tx),
    } as unknown as TenantPrisma;

    service = new AdminDomainsService({} as unknown as SystemPrisma, tenantPrisma, {
      record,
    } as unknown as AuditService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function domain(id: string): DomainRow {
    const row = rows.find((candidate) => candidate.id === id);

    if (row === undefined) {
      throw new Error(`unreachable: no fixture row ${id}`);
    }

    return row;
  }

  describe('deactivate', () => {
    it('hands primary back to the platform subdomain when the live primary is detached', async () => {
      // The state the operator creates during a cert failure or a migration: the
      // custom domain is gone from the edge, and every invite and password-reset
      // link is still addressed to it.
      domain(CUSTOM_ID).isPrimary = true;
      domain(PLATFORM_ID).isPrimary = false;

      await service.deactivate(CUSTOM_HOST);

      expect(domain(CUSTOM_ID)).toMatchObject({ activatedAt: null, isPrimary: false });
      expect(domain(PLATFORM_ID).isPrimary).toBe(true);
    });

    it('clears the old primary before setting the new one, so the unique index cannot reject it', async () => {
      // `tenant_domains_one_primary` is a partial unique index on tenant_id: two
      // rows carrying is_primary in one transaction is a constraint violation,
      // not a last-write-wins. Asserting the order is what keeps a later
      // refactor from splitting these into two independent statements.
      domain(CUSTOM_ID).isPrimary = true;
      domain(PLATFORM_ID).isPrimary = false;

      await service.deactivate(CUSTOM_HOST);

      expect(updates).toEqual([
        { id: CUSTOM_ID, data: { activatedAt: null, isPrimary: false } },
        { id: PLATFORM_ID, data: { isPrimary: true } },
      ]);
    });

    it('names the new host on the deactivation audit row rather than in a row of its own', async () => {
      domain(CUSTOM_ID).isPrimary = true;
      domain(PLATFORM_ID).isPrimary = false;

      await service.deactivate(CUSTOM_HOST);

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(expect.anything(), {
        action: AUDIT_ACTIONS.tenantDomainDeactivated,
        targetType: 'tenant_domain',
        targetId: CUSTOM_ID,
        metadata: { hostname: CUSTOM_HOST, primaryRevertedTo: PLATFORM_HOST },
      });
    });

    it('leaves primary where it is when the detached domain was not the primary', async () => {
      await service.deactivate(CUSTOM_HOST);

      expect(domain(CUSTOM_ID).activatedAt).toBeNull();
      expect(domain(PLATFORM_ID).isPrimary).toBe(true);
      expect(updates).toEqual([{ id: CUSTOM_ID, data: { activatedAt: null } }]);
      expect(record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ metadata: { hostname: CUSTOM_HOST } }),
      );
    });

    it('warns and leaves the tenant without a primary when there is no platform subdomain', async () => {
      // A provisioning fault this path did not cause. Refusing the deactivation
      // would be worse: the hostname is genuinely gone from the edge either way,
      // and `primaryHostname()` already tolerates the absence.
      rows = [customRow({ isPrimary: true })];

      await service.deactivate(CUSTOM_HOST);

      expect(domain(CUSTOM_ID).isPrimary).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(CUSTOM_HOST));
      expect(record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ metadata: { hostname: CUSTOM_HOST } }),
      );
    });

    it('is a no-op the second time, rather than reverting a primary somebody re-promoted', async () => {
      domain(CUSTOM_ID).activatedAt = null;
      domain(CUSTOM_ID).isPrimary = true;
      domain(PLATFORM_ID).isPrimary = false;

      await service.deactivate(CUSTOM_HOST);

      expect(updates).toEqual([]);
      expect(record).not.toHaveBeenCalled();
      expect(domain(CUSTOM_ID).isPrimary).toBe(true);
    });

    it('refuses a hostname this tenant does not hold', async () => {
      await expect(service.deactivate('elsewhere.example')).rejects.toBeInstanceOf(
        TenantDomainNotFoundError,
      );
      expect(updates).toEqual([]);
    });
  });

  describe('activate', () => {
    it('stamps the edge attachment and touches nothing else', async () => {
      domain(CUSTOM_ID).activatedAt = null;

      await service.activate(CUSTOM_HOST);

      expect(domain(CUSTOM_ID).activatedAt).toBeInstanceOf(Date);
      expect(domain(CUSTOM_ID).isPrimary).toBe(false);
      expect(domain(PLATFORM_ID).isPrimary).toBe(true);
      expect(updates).toHaveLength(1);
      expect(updates.at(0)?.id).toBe(CUSTOM_ID);
      // `is_primary` is absent from the payload, not merely unchanged in it:
      // activation says nothing about which host the tenant's links name.
      expect(updates.at(0)?.data).not.toHaveProperty('isPrimary');
      expect(record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: AUDIT_ACTIONS.tenantDomainActivated }),
      );
    });

    it('refuses a domain nobody has proved, so a live row can never answer tenant_not_found', async () => {
      rows = [platformRow({ isPrimary: true }), customRow({ verifiedAt: null, activatedAt: null })];

      await expect(service.activate(CUSTOM_HOST)).rejects.toBeInstanceOf(TenantDomainNotFoundError);
      expect(updates).toEqual([]);
    });
  });
});
