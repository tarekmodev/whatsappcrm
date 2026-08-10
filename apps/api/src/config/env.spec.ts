import { validateEnv } from './env';

describe('validateEnv', () => {
  const productionBase = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:pass@host:5432/db',
    REDIS_URL: 'redis://host:6379',
  };

  it('boots locally without any backing service', () => {
    expect(() => validateEnv({})).not.toThrow();
  });

  /** A production environment with one key missing, which is the case worth catching. */
  function productionWithout(key: keyof typeof productionBase): Record<string, string> {
    const env: Record<string, string> = { ...productionBase };
    delete env[key];

    return env;
  }

  it('refuses to boot in production without a database', () => {
    expect(() => validateEnv(productionWithout('DATABASE_URL'))).toThrow(/DATABASE_URL/);
  });

  it('refuses to boot in production without a queue connection', () => {
    expect(() => validateEnv(productionWithout('REDIS_URL'))).toThrow(/REDIS_URL/);
  });

  it('accepts a fully configured production environment', () => {
    expect(() => validateEnv(productionBase)).not.toThrow();
  });

  it('coerces numeric settings out of their string form', () => {
    const env = validateEnv({ PORT: '8080', SLOW_REQUEST_THRESHOLD_MS: '250' });

    expect(env.PORT).toBe(8080);
    expect(env.SLOW_REQUEST_THRESHOLD_MS).toBe(250);
  });

  it('reads LOG_PRETTY as a flag rather than as a truthy string', () => {
    expect(validateEnv({ LOG_PRETTY: 'false' }).LOG_PRETTY).toBe(false);
    expect(validateEnv({ LOG_PRETTY: 'true' }).LOG_PRETTY).toBe(true);
  });

  it('rejects a deployment environment it does not recognise', () => {
    expect(() => validateEnv({ DEPLOY_ENV: 'prod' })).toThrow(/DEPLOY_ENV/);
  });

  describe('blank values', () => {
    // `.env.example` documents optional keys as `KEY=`, and the README says to copy
    // it — so a blank value has to mean "not set", or a fresh clone cannot boot.
    it('treats a blank optional URL as absent rather than as an invalid one', () => {
      expect(() => validateEnv({ SENTRY_DSN: '' })).not.toThrow();
      expect(validateEnv({ SENTRY_DSN: '' }).SENTRY_DSN).toBeUndefined();
    });

    it('falls back to the default when a value with one is blank', () => {
      expect(validateEnv({ LOG_LEVEL: '', WEB_ORIGIN: '' }).LOG_LEVEL).toBe('info');
      expect(validateEnv({ WEB_ORIGIN: '' }).WEB_ORIGIN).toBe('http://localhost:3000');
    });

    it('accepts the documented example file as-is', () => {
      // The optional keys exactly as `.env.example` ships them.
      expect(() =>
        validateEnv({
          SENTRY_DSN: '',
          WHATSAPP_APP_SECRET: '',
          POLAR_ACCESS_TOKEN: '',
        }),
      ).not.toThrow();
    });

    it('still refuses to boot in production when a required value is blank', () => {
      expect(() => validateEnv({ ...productionBase, DATABASE_URL: '' })).toThrow(
        /DATABASE_URL: is required when NODE_ENV=production/,
      );
    });
  });
});
