import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PROXY_PATH_PREFIX,
  EDGE_AUTH_HEADER,
  FORWARDED_HOST_HEADER,
  isApiProxyPath,
  tenantForwardingHeaders,
} from './tenant-forwarding';

/**
 * The pair the API reads to decide which tenant a request is for. What these
 * cases pin down is the part a reviewer cannot see by reading one call site: the
 * secret is sent only when there is one, and the two request paths build the pair
 * from the same function so they cannot drift.
 */

const { env } = vi.hoisted(() => ({ env: { trustedProxySecret: null as string | null } }));

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

describe('tenantForwardingHeaders', () => {
  it('names the tenant and proves the claim when a secret is configured', () => {
    env.trustedProxySecret = 'edge-secret';

    expect(tenantForwardingHeaders('northwind.app.localhost:3000')).toEqual({
      [FORWARDED_HOST_HEADER]: 'northwind.app.localhost:3000',
      [EDGE_AUTH_HEADER]: 'edge-secret',
    });
  });

  /**
   * Local development and docker-compose, where the API still reads `Host`. An
   * empty `x-edge-auth` would be a value the guard has to special-case, so the
   * header is omitted rather than blanked.
   */
  it('sends no credential header at all when no secret is configured', () => {
    const headers = tenantForwardingHeaders('acme.app.localhost:3000');

    expect(headers).toEqual({ [FORWARDED_HOST_HEADER]: 'acme.app.localhost:3000' });
    expect(headers).not.toHaveProperty(EDGE_AUTH_HEADER);
  });

  it('keeps the port, which distinguishes two tenants in local development', () => {
    expect(tenantForwardingHeaders('acme.app.localhost:3000')[FORWARDED_HOST_HEADER]).toContain(
      ':3000',
    );
  });

  /**
   * The header Next's own rewrite proxy already sets on the browser path, so the
   * API has one place to read the tenant from rather than two.
   */
  it('uses the header names the API guard reads', () => {
    expect(FORWARDED_HOST_HEADER).toBe('x-forwarded-host');
    expect(EDGE_AUTH_HEADER).toBe('x-edge-auth');
  });
});

describe('isApiProxyPath', () => {
  it('matches the path the browser reaches the API through', () => {
    expect(isApiProxyPath('/api/v1/auth/login')).toBe(true);
    expect(isApiProxyPath(API_PROXY_PATH_PREFIX)).toBe(true);
  });

  /**
   * A page whose name merely starts with the same letters is a page, and must
   * still get the session guard rather than a silent pass to the API.
   */
  it('does not match a route that only shares the prefix', () => {
    expect(isApiProxyPath('/api-keys')).toBe(false);
    expect(isApiProxyPath('/inbox')).toBe(false);
  });
});
