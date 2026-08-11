import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import type { SystemPrisma } from '../prisma/prisma.tokens';
import { TenantNotFoundError } from './tenant-deactivation.errors';
import {
  TenantDeactivationService,
  TENANT_DEACTIVATED_ACTION,
} from './tenant-deactivation.service';

/**
 * The decisions deactivation makes before it writes anything: which statuses it
 * acts on, what it leaves alone, and what it records. The database is stubbed —
 * that the write actually locks the tenant out is a property of the database
 * and is proved in `tenant-deactivation.int-spec.ts`.
 */

const TENANT_ID = '51444444-4444-7444-8444-4444444444a1';
const SLUG = 'acme';

type TenantRow = {
  id: string;
  slug: string;
  name: string;
  status: 'pending' | 'active' | 'suspended' | 'cancelled';
  suspendedAt: Date | null;
};

const ACTIVE: TenantRow = {
  id: TENANT_ID,
  slug: SLUG,
  name: 'Acme Ltd',
  status: 'active',
  suspendedAt: null,
};

/** What the stubbed `SELECT now()` returns — the database's clock, not the process's. */
const DATABASE_NOW = new Date('2026-08-10T10:30:00.000Z');

describe('TenantDeactivationService', () => {
  let findUnique: jest.Mock;
  let update: jest.Mock;
  let createAuditLog: jest.Mock;
  let executeRaw: jest.Mock;
  let queryRaw: jest.Mock;
  let tenantContext: TenantContextService;
  let service: TenantDeactivationService;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(ACTIVE);
    update = jest.fn().mockImplementation(({ data }: { data: Partial<TenantRow> }) =>
      Promise.resolve({
        ...ACTIVE,
        status: data.status ?? ACTIVE.status,
        suspendedAt: data.suspendedAt ?? null,
      }),
    );
    createAuditLog = jest.fn().mockResolvedValue({ id: 'audit' });
    executeRaw = jest.fn().mockResolvedValue(1);
    queryRaw = jest.fn().mockResolvedValue([{ now: DATABASE_NOW }]);

    const tx = {
      $executeRaw: executeRaw,
      $queryRaw: queryRaw,
      tenant: { findUnique, update },
      auditLog: { create: createAuditLog },
    } as unknown as Prisma.TransactionClient;

    const systemPrisma = {
      $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => work(tx),
    } as unknown as SystemPrisma;

    tenantContext = new TenantContextService();
    service = new TenantDeactivationService(systemPrisma, tenantContext);
  });

  /** Runs `work` as if `PlatformAdminGuard` had authenticated `label`. */
  function asOperator<T>(label: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: 'req_deactivation', tenantId: null, userId: null, principal: null },
      async () => {
        tenantContext.setPlatformActor(label);

        return await work();
      },
    );
  }

  describe('deactivating a running tenant', () => {
    it('suspends it and stamps when access was revoked', async () => {
      const { tenant, deactivated } = await service.deactivate({ slug: SLUG });

      expect(deactivated).toBe(true);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TENANT_ID },
          // The database's clock, not the process's: the audit row's own
          // `created_at` default resolves to the same `now()` inside this
          // transaction, so the two cannot disagree by however far two API
          // instances have drifted apart.
          data: { status: 'suspended', suspendedAt: DATABASE_NOW },
        }),
      );
      expect(tenant.status).toBe('suspended');
      expect(tenant.suspendedAt).toEqual(DATABASE_NOW);
    });

    it('writes nothing else, so the tenant keeps its data', async () => {
      await service.deactivate({ slug: SLUG });

      // The whole of deactivation is two columns on one row. Anything else
      // written here — a delete, an anonymisation, a cascade — would make this
      // a destructive operation rather than a reversible one.
      expect(update).toHaveBeenCalledTimes(1);

      const [{ data }] = update.mock.calls[0] as [{ data: Record<string, unknown> }];
      expect(Object.keys(data).sort()).toEqual(['status', 'suspendedAt']);
    });

    it('records who lost access and why, in the same transaction as the write', async () => {
      await asOperator('ops-alice', () =>
        service.deactivate({ slug: SLUG, reason: 'Non-payment, ticket OPS-412' }),
      );

      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            // The operator credential that authenticated the request (TAR-166),
            // not a user: the platform is never a row in this tenant's `users`.
            actorType: 'platform_operator',
            actorUserId: null,
            actorLabel: 'ops-alice',
            action: TENANT_DEACTIVATED_ACTION,
            targetType: 'tenant',
            targetId: TENANT_ID,
            // Named rather than left to the column default: Prisma generates
            // `@default(now())` itself, so the default never fires and the
            // audit entry would carry the process clock at insert time.
            createdAt: DATABASE_NOW,
            metadata: { reason: 'Non-payment, ticket OPS-412' },
          }) as unknown,
        }),
      );
    });

    it('records the deactivation even when no reason was given', async () => {
      await service.deactivate({ slug: SLUG });

      expect(createAuditLog).toHaveBeenCalledTimes(1);

      const [{ data }] = createAuditLog.mock.calls[0] as [{ data: { metadata?: unknown } }];
      expect(data.metadata).toBeUndefined();
    });

    it('serialises on the slug, so two operators produce one write', async () => {
      await service.deactivate({ slug: SLUG });

      expect(executeRaw).toHaveBeenCalledTimes(1);

      const [fragments, ...values] = executeRaw.mock.calls[0] as [string[], ...unknown[]];

      expect(fragments.join('?')).toContain('pg_advisory_xact_lock');
      expect(values).toEqual([`tenant-deactivation:${SLUG}`]);
    });
  });

  describe('a tenant that is already inaccessible', () => {
    it.each(['suspended', 'cancelled'] as const)('leaves a %s tenant untouched', async (status) => {
      const suspendedAt = new Date('2026-08-01T00:00:00.000Z');
      findUnique.mockResolvedValue({ ...ACTIVE, status, suspendedAt });

      const result = await service.deactivate({ slug: SLUG });

      expect(result.deactivated).toBe(false);
      expect(result.tenant.status).toBe(status);
      // The original stamp survives: it is the record of when access was
      // actually revoked, and a replayed script must not move it.
      expect(result.tenant.suspendedAt).toEqual(suspendedAt);
      expect(update).not.toHaveBeenCalled();
      expect(createAuditLog).not.toHaveBeenCalled();
    });
  });

  describe('a tenant that does not exist', () => {
    it('says so rather than reporting a success', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.deactivate({ slug: 'typo' })).rejects.toBeInstanceOf(
        TenantNotFoundError,
      );
      expect(update).not.toHaveBeenCalled();
    });
  });
});
