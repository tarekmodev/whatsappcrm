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
});
