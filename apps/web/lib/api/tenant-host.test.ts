import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDGE_AUTH_HEADER, FORWARDED_HOST_HEADER, tenantHostHeaders } from './tenant-host';

/**
 * The tenant is the host, and nothing else. What these cases pin down is that a
 * server-side call says which host it came in on, and that a call which cannot
 * say fails here rather than three layers down as a `tenant_not_found` 404.
 *
 * The shape of the header pair belongs to `tenant-forwarding.test.ts`; this file
 * covers only the part that is this module's own — reading the incoming host.
 */

const { host, env } = vi.hoisted(() => ({
  host: { value: null as string | null },
  env: { trustedProxySecret: null as string | null },
}));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(host.value === null ? {} : { host: host.value })),
}));

vi.mock('@/lib/config/env', () => ({
  webEnv: {
    get trustedProxySecret(): string | null {
      return env.trustedProxySecret;
    },
  },
}));

afterEach(() => {
  env.trustedProxySecret = null;
});

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

  /**
   * Without the credential the guard reads `Host` — the API's own host — and
   * answers `tenant_not_found`, so the forwarded host alone buys nothing.
   */
  it('proves the forwarded host with the shared secret when one is configured', async () => {
    env.trustedProxySecret = 'edge-secret';
    host.value = 'northwind.app.localhost:3000';

    await expect(tenantHostHeaders()).resolves.toEqual({
      [FORWARDED_HOST_HEADER]: 'northwind.app.localhost:3000',
      [EDGE_AUTH_HEADER]: 'edge-secret',
    });
  });

  it('refuses to make a call that cannot name a tenant', async () => {
    host.value = null;

    await expect(tenantHostHeaders()).rejects.toThrow(/no Host/i);
  });
});
