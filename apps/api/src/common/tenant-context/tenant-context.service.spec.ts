import { TenantContextService } from './tenant-context.service';

describe('TenantContextService', () => {
  let service: TenantContextService;

  beforeEach(() => {
    service = new TenantContextService();
  });

  it('reports no context outside of a scope', () => {
    expect(service.get()).toBeUndefined();
    expect(service.tenantId).toBeNull();
    expect(service.requestId).toBeNull();
  });

  it('exposes the context inside a scope', () => {
    service.run(
      { requestId: 'req_1', tenantId: 'tenant_a', userId: 'user_1', principal: null },
      () => {
        expect(service.requestId).toBe('req_1');
        expect(service.tenantId).toBe('tenant_a');
        expect(service.requireTenantId()).toBe('tenant_a');
      },
    );
  });

  it('survives an await boundary', async () => {
    await service.run(
      { requestId: 'req_2', tenantId: 'tenant_b', userId: null, principal: null },
      async () => {
        await Promise.resolve();
        expect(service.tenantId).toBe('tenant_b');
      },
    );
  });

  it('keeps concurrent scopes isolated from each other', async () => {
    const observe = (tenantId: string, delayMs: number): Promise<string | null> =>
      service.run(
        { requestId: `req_${tenantId}`, tenantId, userId: null, principal: null },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return service.tenantId;
        },
      );

    await expect(Promise.all([observe('tenant_a', 20), observe('tenant_b', 1)])).resolves.toEqual([
      'tenant_a',
      'tenant_b',
    ]);
  });

  it('attaches a resolved session to the active scope', () => {
    service.run({ requestId: 'req_3', tenantId: null, userId: null, principal: null }, () => {
      expect(service.tenantId).toBeNull();
      service.setTenant('tenant_c', 'user_9');
      expect(service.tenantId).toBe('tenant_c');
      expect(service.userId).toBe('user_9');
    });
  });

  it('refuses to set a tenant outside of a scope', () => {
    expect(() => service.setTenant('tenant_d')).toThrow(/outside of a tenant context scope/);
  });

  it('throws rather than silently running unscoped', () => {
    service.run({ requestId: 'req_4', tenantId: null, userId: null, principal: null }, () => {
      expect(() => service.requireTenantId()).toThrow(/No tenant in scope/);
    });
  });
});
