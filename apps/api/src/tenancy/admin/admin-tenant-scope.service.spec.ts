import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import type { SystemPrisma } from '../../prisma/prisma.tokens';
import { TenantNotFoundError } from '../tenant-deactivation.errors';
import { AdminTenantScopeService } from './admin-tenant-scope.service';

/**
 * The step that lets a platform-admin route write tenant data through
 * `TenantPrisma` instead of through an unscoped client and a hand-written
 * filter: resolve one tenant by slug, bind it to this request's scope.
 */

const TENANT_ID = '50444444-4444-7444-8444-4444444444c1';

describe('AdminTenantScopeService', () => {
  let findUnique: jest.Mock;
  let tenantContext: TenantContextService;
  let service: AdminTenantScopeService;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue({ id: TENANT_ID });
    tenantContext = new TenantContextService();
    service = new AdminTenantScopeService(
      { tenant: { findUnique } } as unknown as SystemPrisma,
      tenantContext,
    );
  });

  it('puts the named tenant into scope for the rest of the request', async () => {
    await tenantContext.run({ requestId: 'r1', tenantId: null, userId: null }, async () => {
      await expect(service.enter('acme')).resolves.toBe(TENANT_ID);

      expect(tenantContext.tenantId).toBe(TENANT_ID);
    });
  });

  it('reads nothing but the id — an admin route does not need the rest of the tenant', async () => {
    await tenantContext.run({ requestId: 'r1', tenantId: null, userId: null }, async () => {
      await service.enter('acme');
    });

    expect(findUnique).toHaveBeenCalledWith({ where: { slug: 'acme' }, select: { id: true } });
  });

  it('leaves no tenant in scope when the slug names nothing', async () => {
    findUnique.mockResolvedValue(null);

    await tenantContext.run({ requestId: 'r1', tenantId: null, userId: null }, async () => {
      await expect(service.enter('nope')).rejects.toBeInstanceOf(TenantNotFoundError);

      // Fail-closed: every downstream query still refuses rather than running
      // against whatever happened to be in scope.
      expect(tenantContext.tenantId).toBeNull();
    });
  });
});
