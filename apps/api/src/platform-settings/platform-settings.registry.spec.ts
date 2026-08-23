import { PlatformSettingParamsSchema } from '@whatsappcrm/contracts';
import { envSchema } from '../config/env.schema';
import { PLATFORM_SETTINGS, platformSettingDefinition } from './platform-settings.registry';

/**
 * The registry is the allowlist, so what is asserted here is what the allowlist
 * promises rather than that the four entries are present.
 *
 * The load-bearing one is the last describe block: a key in the bootstrap tier
 * would be a configuration surface that can lock the platform out of its own
 * database, its own ciphertext or its own admin API, and the only thing standing
 * between that and a plausible-looking pull request is this test.
 */
describe('the platform settings registry', () => {
  it('names each key once', () => {
    const keys = PLATFORM_SETTINGS.map((setting) => setting.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('maps each key to a distinct environment variable', () => {
    // Two keys sharing a variable would mean writing one silently changes what
    // the other falls back to.
    const envVars = PLATFORM_SETTINGS.map((setting) => setting.envVar);

    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it('uses keys the published path parameter accepts', () => {
    // The contract validates the path before the lookup runs, so a key the
    // pattern rejects would be a registered setting no request could reach.
    for (const setting of PLATFORM_SETTINGS) {
      expect(PlatformSettingParamsSchema.safeParse({ key: setting.key }).success).toBe(true);
    }
  });

  it('falls back only to variables the environment schema declares', () => {
    // A typo in `envVar` would make the key read as unset in every environment
    // that had set the real variable — a silent regression to fail-closed.
    const declared = new Set(Object.keys(envSchema.def.shape));

    for (const setting of PLATFORM_SETTINGS) {
      expect(declared).toContain(setting.envVar);
    }
  });

  it('describes every key without describing any value', () => {
    for (const setting of PLATFORM_SETTINGS) {
      expect(setting.description.length).toBeGreaterThan(0);
    }
  });

  it('answers null for a key it does not manage, rather than throwing', () => {
    // Both callers have something specific to do with "not managed" — the HTTP
    // layer answers 404 and the snapshot loader ignores the row — and neither is
    // an exception.
    expect(platformSettingDefinition('whatsapp.app_secret')).not.toBeNull();
    expect(platformSettingDefinition('database.url')).toBeNull();
  });

  describe('the bootstrap tier', () => {
    /**
     * Configuration that must never be manageable through this surface, and why
     * each one would be a trap:
     *
     *   - the database URLs are needed to *read* the table;
     *   - the encryption keys are needed to decrypt what is in it;
     *   - `PLATFORM_ADMIN_TOKEN` authenticates the surface that writes it, so a
     *     bad write locks out every operator with no second channel;
     *   - the rest is process-level configuration a running instance cannot
     *     adopt without restarting anyway.
     */
    const EXCLUDED = [
      'APP_DATABASE_URL',
      'SYSTEM_DATABASE_URL',
      'DATABASE_URL',
      'SECRETS_ENCRYPTION_KEY',
      'WHATSAPP_TOKEN_ENCRYPTION_KEY',
      'PLATFORM_ADMIN_TOKEN',
      'SESSION_SECRET',
      'TRUSTED_PROXY_SECRET',
      'REDIS_URL',
      'PORT',
      'NODE_ENV',
      'DEPLOY_ENV',
      'MEDIA_STORAGE_ROOT',
    ];

    it.each(EXCLUDED)('never manages %s', (envVar) => {
      expect(PLATFORM_SETTINGS.map((setting) => setting.envVar)).not.toContain(envVar);
    });
  });

  describe('write validation', () => {
    it('holds secrets to a length floor, because their fingerprints are published', () => {
      // An 8-hex prefix of SHA-256 is offline-guessable for a low-entropy value,
      // and the verify token is operator-chosen.
      for (const setting of PLATFORM_SETTINGS.filter((s) => s.sensitivity === 'secret')) {
        expect(setting.schema.safeParse('short').success).toBe(false);
        expect(setting.schema.safeParse('x'.repeat(32)).success).toBe(true);
      }
    });

    it('holds Meta ids to digits, so a fat-fingered paste is refused here', () => {
      for (const setting of PLATFORM_SETTINGS.filter((s) => s.sensitivity === 'public')) {
        expect(setting.schema.safeParse('1234567890123456').success).toBe(true);
        expect(setting.schema.safeParse('my-app').success).toBe(false);
      }
    });
  });
});
