import { describe, expect, it, vi } from 'vitest';
import { EDGE_AUTH_HEADER, TENANT_HOST_HEADER } from '@whatsappcrm/contracts';
import { tenantRoutingHeaders } from './tenant-host';

/**
 * The tenant is the host, and the secret is what makes the host believable.
 * What these cases pin down is that a server-side call says which host it came
 * in on, that it proves the claim, and that a call which can do neither fails
 * here rather than three layers down as a `tenant_not_found` 404.
 */

const { host, env } = vi.hoisted(() => ({
  host: { value: null as string | null },
  env: { trustedProxySecret: null as string | null, isProduction: false },
}));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(host.value === null ? {} : { host: host.value })),
}));

vi.mock('@/lib/config/env', () => ({ webEnv: env }));

describe('tenantRoutingHeaders', () => {
  it('forwards the host the request arrived on, with the secret that vouches for it', async () => {
    host.value = 'northwind.app.localhost:3000';
    env.trustedProxySecret = 'shared-secret';

    await expect(tenantRoutingHeaders()).resolves.toEqual({
      [TENANT_HOST_HEADER]: 'northwind.app.localhost:3000',
      [EDGE_AUTH_HEADER]: 'shared-secret',
    });
  });

  it('keeps the port, which is what distinguishes two tenants in local development', async () => {
    host.value = 'acme.app.localhost:3000';
    env.trustedProxySecret = 'shared-secret';

    const headers = await tenantRoutingHeaders();

    expect(headers[TENANT_HOST_HEADER]).toContain(':3000');
  });

  it('refuses to make a call that cannot name a tenant', async () => {
    host.value = null;
    env.trustedProxySecret = 'shared-secret';

    await expect(tenantRoutingHeaders()).rejects.toThrow(/no Host/i);
  });

  /**
   * Local development against a stack that has no secret configured: the host
   * still goes, unproven, and the API refuses it exactly as it would refuse a
   * forged one. Sending it is not what makes it trusted.
   */
  it('sends the host without the secret outside production', async () => {
    host.value = 'northwind.app.localhost:3000';
    env.trustedProxySecret = null;

    await expect(tenantRoutingHeaders()).resolves.toEqual({
      [TENANT_HOST_HEADER]: 'northwind.app.localhost:3000',
    });
  });

  /**
   * In production an unconfigured secret means every tenant route answers
   * `tenant_not_found` — total, and worth failing on rather than discovering one
   * request at a time.
   */
  it('refuses to run in production with no secret configured', async () => {
    host.value = 'northwind.example.com';
    env.trustedProxySecret = null;
    env.isProduction = true;

    await expect(tenantRoutingHeaders()).rejects.toThrow(/TRUSTED_PROXY_SECRET/);

    env.isProduction = false;
  });
});
