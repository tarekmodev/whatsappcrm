import { validateEnv } from './env';
import { AUTH_STUB_ON } from './env.schema';

/**
 * The stub kill switch, asserted at the layer that actually stops a deploy.
 *
 * `validateEnv` runs while `ConfigModule` is initialising — before a route is
 * mapped, before the readiness probe can answer. That is the difference between
 * a misconfigured production deploy failing to boot and one coming up healthy
 * and serving requests with a fabricated principal.
 */
const REQUIRED = {
  APP_DATABASE_URL: 'postgresql://app@localhost:5432/db',
  SYSTEM_DATABASE_URL: 'postgresql://system@localhost:5432/db',
  // Only mandatory under NODE_ENV=production (TAR-41 and TAR-64), but every case
  // here needs to satisfy those rules for the production assertions below to
  // reach the one they are actually about.
  REDIS_URL: 'redis://localhost:6379',
  TRUSTED_PROXY_SECRET: 'a5f3c1d9e7b2486a0c4f8e1d3b7a9204',
};

describe('environment validation', () => {
  it('defaults the interim role stub to off', () => {
    expect(validateEnv({ ...REQUIRED }).AUTH_STUB_ENABLED).toBe('false');
  });

  it('accepts the stub outside production', () => {
    for (const NODE_ENV of ['development', 'test'] as const) {
      expect(
        validateEnv({ ...REQUIRED, NODE_ENV, AUTH_STUB_ENABLED: 'true' }).AUTH_STUB_ENABLED,
      ).toBe(AUTH_STUB_ON);
    }
  });

  // The CI assertion TAR-79 asks for: a production config cannot enable it.
  it('refuses to boot with the stub enabled in production', () => {
    expect(() =>
      validateEnv({ ...REQUIRED, NODE_ENV: 'production', AUTH_STUB_ENABLED: 'true' }),
    ).toThrow(/AUTH_STUB_ENABLED/);
  });

  it('boots in production with the stub off', () => {
    expect(
      validateEnv({ ...REQUIRED, NODE_ENV: 'production', AUTH_STUB_ENABLED: 'false' })
        .AUTH_STUB_ENABLED,
    ).not.toBe(AUTH_STUB_ON);
  });

  it('rejects a value that is neither true nor false rather than reading it as off', () => {
    // `AUTH_STUB_ENABLED=1` silently meaning "off" is how a developer concludes
    // the switch is broken and reaches for something worse.
    expect(() => validateEnv({ ...REQUIRED, AUTH_STUB_ENABLED: '1' })).toThrow(/AUTH_STUB_ENABLED/);
  });

  describe('the forwarded-host trust secret (TAR-64)', () => {
    it('refuses to boot in production without it', () => {
      // Blank rather than deleted: `validateEnv` drops empty values before it
      // validates, which is exactly what `TRUSTED_PROXY_SECRET=` in a `.env`
      // means, and it is the shape a half-provisioned environment actually has.
      const withoutSecret = { ...REQUIRED, TRUSTED_PROXY_SECRET: '' };

      // Not a per-request check: without it `HostTenantGuard` resolves the API's
      // own hostname, matches no tenant domain, and every tenant route answers
      // tenant_not_found. An API that cannot route to a tenant serves nothing,
      // so failing at startup beats booting healthy and 404ing everything.
      expect(() => validateEnv({ ...withoutSecret, NODE_ENV: 'production' })).toThrow(
        /TRUSTED_PROXY_SECRET/,
      );
    });

    it('is optional outside production, where the browser reaches the API directly', () => {
      // Blank rather than deleted: `validateEnv` drops empty values before it
      // validates, which is exactly what `TRUSTED_PROXY_SECRET=` in a `.env`
      // means, and it is the shape a half-provisioned environment actually has.
      const withoutSecret = { ...REQUIRED, TRUSTED_PROXY_SECRET: '' };

      // Local development and docker-compose talk to `*.app.localhost` with no
      // edge in between, so `Host` is already the tenant's.
      expect(() => validateEnv({ ...withoutSecret, NODE_ENV: 'development' })).not.toThrow();
    });

    it('accepts the previous value alongside the current one, for a rotation', () => {
      const env = validateEnv({
        ...REQUIRED,
        NODE_ENV: 'production',
        TRUSTED_PROXY_SECRET_PREVIOUS: 'ffe2d1c0b9a8776655443322110099887766554433221100',
      });

      // Both live at once for the length of a rotation, so the web tier and the
      // API can be rolled one at a time instead of in the same instant.
      expect(env.TRUSTED_PROXY_SECRET_PREVIOUS).not.toBe(env.TRUSTED_PROXY_SECRET);
      expect(env.TRUSTED_PROXY_SECRET_PREVIOUS).toBeDefined();
    });
  });

  describe('the session cookie kill switch (TAR-56)', () => {
    it('defaults to secure, so an environment that says nothing gets the __Host- prefix', () => {
      expect(validateEnv({ ...REQUIRED }).SESSION_COOKIE_SECURE).toBe(true);
    });

    it('allows it off outside production, which is the only reason it exists', () => {
      // Safari does not treat plain-HTTP localhost as a secure context, so a
      // `__Host-` cookie cannot be set there at all.
      expect(
        validateEnv({ ...REQUIRED, NODE_ENV: 'development', SESSION_COOKIE_SECURE: 'false' })
          .SESSION_COOKIE_SECURE,
      ).toBe(false);
    });

    it('refuses to boot with it off in production', () => {
      // A session cookie without `Secure` travels in clear text over any
      // plain-HTTP hop, and drops the prefix that stops a sibling tenant
      // subdomain shadowing it.
      expect(() =>
        validateEnv({ ...REQUIRED, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' }),
      ).toThrow(/SESSION_COOKIE_SECURE/);
    });
  });
});
