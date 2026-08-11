import { validateEnv } from './env';

/** The two role connections are mandatory (TAR-49), so every case carries them. */
const DATABASE_ROLES = {
  APP_DATABASE_URL: 'postgresql://whatsappcrm_app:pw@host:5432/db',
  SYSTEM_DATABASE_URL: 'postgresql://whatsappcrm_system:pw@host:5432/db',
};

const PRODUCTION = {
  ...DATABASE_ROLES,
  NODE_ENV: 'production',
  REDIS_URL: 'redis://host:6379',
  // Every deployed environment is behind Render's edge, where `Host` names the
  // API service rather than a tenant, so the guard has nothing to resolve from
  // without this (TAR-64, ADR 0003).
  TRUSTED_PROXY_SECRET: 'a5f3c1d9e7b2486a0c4f8e1d3b7a9204',
};

/** A copy of `base` with one key removed — the case each test is actually about. */
function without(
  key: string,
  base: Record<string, string> = DATABASE_ROLES,
): Record<string, string> {
  const copy = { ...base };
  delete copy[key];

  return copy;
}
describe('validateEnv', () => {
  it('boots locally with the database roles and nothing else', () => {
    expect(() => validateEnv({ ...DATABASE_ROLES })).not.toThrow();
  });

  it('refuses to boot without the tenant-scoped connection', () => {
    expect(() => validateEnv(without('APP_DATABASE_URL'))).toThrow(/APP_DATABASE_URL/);
  });

  it('refuses to boot without the system connection', () => {
    expect(() => validateEnv(without('SYSTEM_DATABASE_URL'))).toThrow(/SYSTEM_DATABASE_URL/);
  });

  it('refuses to boot in production without a queue connection', () => {
    expect(() => validateEnv(without('REDIS_URL', PRODUCTION))).toThrow(
      /REDIS_URL: is required when NODE_ENV=production/,
    );
  });

  it('does not require a queue connection outside production', () => {
    expect(() => validateEnv({ ...DATABASE_ROLES, NODE_ENV: 'development' })).not.toThrow();
  });

  it('accepts a fully configured production environment', () => {
    expect(() => validateEnv(PRODUCTION)).not.toThrow();
  });

  it('coerces numeric settings out of their string form', () => {
    const env = validateEnv({ ...DATABASE_ROLES, PORT: '8080', SLOW_REQUEST_THRESHOLD_MS: '250' });

    expect(env.PORT).toBe(8080);
    expect(env.SLOW_REQUEST_THRESHOLD_MS).toBe(250);
  });

  it('reads LOG_PRETTY as a flag rather than as a truthy string', () => {
    expect(validateEnv({ ...DATABASE_ROLES, LOG_PRETTY: 'false' }).LOG_PRETTY).toBe(false);
    expect(validateEnv({ ...DATABASE_ROLES, LOG_PRETTY: 'true' }).LOG_PRETTY).toBe(true);
  });

  it('rejects a deployment environment it does not recognise', () => {
    expect(() => validateEnv({ ...DATABASE_ROLES, DEPLOY_ENV: 'prod' })).toThrow(/DEPLOY_ENV/);
  });

  describe('blank values', () => {
    // `.env.example` documents optional keys as `KEY=`, and the README says to copy
    // it — so a blank value has to mean "not set", or a fresh clone cannot boot.
    it('treats a blank optional URL as absent rather than as an invalid one', () => {
      const env = validateEnv({ ...DATABASE_ROLES, SENTRY_DSN: '' });

      expect(env.SENTRY_DSN).toBeUndefined();
    });

    it('falls back to the default when a value with one is blank', () => {
      const env = validateEnv({ ...DATABASE_ROLES, LOG_LEVEL: '', WEB_ORIGIN: '' });

      expect(env.LOG_LEVEL).toBe('info');
      expect(env.WEB_ORIGIN).toBe('http://localhost:3000');
    });

    it('accepts the optional keys exactly as .env.example ships them', () => {
      expect(() =>
        validateEnv({
          ...DATABASE_ROLES,
          SENTRY_DSN: '',
          WHATSAPP_APP_SECRET: '',
          POLAR_ACCESS_TOKEN: '',
        }),
      ).not.toThrow();
    });

    it('still refuses a blank mandatory connection rather than accepting an empty one', () => {
      expect(() => validateEnv({ ...DATABASE_ROLES, APP_DATABASE_URL: '' })).toThrow(
        /APP_DATABASE_URL/,
      );
    });

    it('still refuses to boot in production when the queue connection is blank', () => {
      expect(() => validateEnv({ ...PRODUCTION, REDIS_URL: '' })).toThrow(
        /REDIS_URL: is required when NODE_ENV=production/,
      );
    });
  });
});
