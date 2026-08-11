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
});
