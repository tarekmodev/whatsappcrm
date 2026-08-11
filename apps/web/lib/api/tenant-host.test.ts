import { describe, expect, it, vi } from 'vitest';
import { FORWARDED_HOST_HEADER, tenantHostHeaders } from './tenant-host';

/**
 * The tenant is the host, and nothing else. What these cases pin down is that a
 * server-side call says which host it came in on, and that a call which cannot
 * say fails here rather than three layers down as a `tenant_not_found` 404.
 */

const { host } = vi.hoisted(() => ({ host: { value: null as string | null } }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(host.value === null ? {} : { host: host.value })),
}));

describe('tenantHostHeaders', () => {
  it('forwards the host the request arrived on', async () => {
    host.value = 'northwind.app.localhost:3000';

    await expect(tenantHostHeaders()).resolves.toEqual({
      [FORWARDED_HOST_HEADER]: 'northwind.app.localhost:3000',
    });
  });

  it('keeps the port, which distinguishes two tenants in local development', async () => {
    host.value = 'acme.app.localhost:3000';

    const headers = await tenantHostHeaders();

    expect(headers[FORWARDED_HOST_HEADER]).toContain(':3000');
  });

  /**
   * The header Next's own proxy already sets on the browser path, so the API has
   * one place to read the tenant from rather than two.
   */
  it('uses the same header the browser path already carries', () => {
    expect(FORWARDED_HOST_HEADER).toBe('x-forwarded-host');
  });

  it('refuses to make a call that cannot name a tenant', async () => {
    host.value = null;

    await expect(tenantHostHeaders()).rejects.toThrow(/no Host/i);
  });
});
