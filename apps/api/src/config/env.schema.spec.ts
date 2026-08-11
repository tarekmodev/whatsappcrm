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
  // Only mandatory under NODE_ENV=production (TAR-41), but every case here needs
  // to satisfy that rule for the production assertions below to reach the one
  // they are actually about.
  REDIS_URL: 'redis://localhost:6379',
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
