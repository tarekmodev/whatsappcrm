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
  // Only mandatory under NODE_ENV=production (TAR-41, TAR-148), but every case
  // here needs to satisfy those rules for the production assertions below to
  // reach the one they are actually about.
  REDIS_URL: 'redis://localhost:6379',
  TRUSTED_PROXY_SECRET: 'a'.repeat(64),
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

  describe('the edge trust boundary (TAR-148)', () => {
    // Blank rather than absent, which `validateEnv` strips to the same thing —
    // and is what copying `.env.example` verbatim actually produces.
    const WITHOUT_SECRET = { ...REQUIRED, TRUSTED_PROXY_SECRET: '' };

    it('is optional outside production, where the guard reads Host as it always has', () => {
      expect(validateEnv({ ...WITHOUT_SECRET }).TRUSTED_PROXY_SECRET).toBeUndefined();
    });

    it('refuses to boot in production without it', () => {
      // Behind Render's edge `Host` is the API's own host, so an API with no
      // secret resolves no tenant at all — a total outage that answers a uniform
      // `tenant_not_found` and reads as an unknown domain. Better a failed deploy.
      expect(() => validateEnv({ ...WITHOUT_SECRET, NODE_ENV: 'production' })).toThrow(
        /TRUSTED_PROXY_SECRET/,
      );
    });

    it('boots in production with it set', () => {
      expect(validateEnv({ ...REQUIRED, NODE_ENV: 'production' }).TRUSTED_PROXY_SECRET).toBe(
        REQUIRED.TRUSTED_PROXY_SECRET,
      );
    });

    it('rejects a secret short enough to be guessed', () => {
      expect(() => validateEnv({ ...REQUIRED, TRUSTED_PROXY_SECRET: 'too-short' })).toThrow(
        /TRUSTED_PROXY_SECRET/,
      );
    });

    it('accepts the previous secret alongside the current one, so rotation is three deploys', () => {
      const env = validateEnv({
        ...REQUIRED,
        NODE_ENV: 'production',
        TRUSTED_PROXY_SECRET_PREVIOUS: 'b'.repeat(64),
      });

      expect(env.TRUSTED_PROXY_SECRET_PREVIOUS).toBe('b'.repeat(64));
    });
  });

  describe('named platform-admin credentials (TAR-166)', () => {
    const SECRET = 'a-platform-admin-secret-of-at-least-32-chars';

    it('is optional, and absent disables the admin surface rather than the boot', () => {
      expect(validateEnv({ ...REQUIRED, PLATFORM_ADMIN_TOKEN: '' }).PLATFORM_ADMIN_TOKEN).toBe(
        undefined,
      );
    });

    it('accepts several named entries', () => {
      const configured = `ops-alice:${SECRET},ci-provisioner:${SECRET}x`;

      expect(
        validateEnv({ ...REQUIRED, PLATFORM_ADMIN_TOKEN: configured }).PLATFORM_ADMIN_TOKEN,
      ).toBe(configured);
    });

    it('refuses to boot on the old unlabelled form', () => {
      // Deliberately not a transitional dual-accept. A bare secret authenticates
      // fine and writes an audit row that cannot say which operator acted, which
      // is the gap this release closes — so it fails the deploy rather than
      // passing silently.
      expect(() => validateEnv({ ...REQUIRED, PLATFORM_ADMIN_TOKEN: SECRET })).toThrow(
        /PLATFORM_ADMIN_TOKEN/,
      );
    });

    it('refuses a short secret, a bad label and a repeated label', () => {
      for (const configured of [
        'ops-alice:short',
        `Ops Alice:${SECRET}`,
        `ops-alice:${SECRET},ops-alice:${SECRET}x`,
      ]) {
        expect(() => validateEnv({ ...REQUIRED, PLATFORM_ADMIN_TOKEN: configured })).toThrow(
          /PLATFORM_ADMIN_TOKEN/,
        );
      }
    });

    it('tolerates a trailing separator, which a hand-edited value collects', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, PLATFORM_ADMIN_TOKEN: `ops-alice:${SECRET},` }),
      ).not.toThrow();
    });

    it('never puts the secret in the failure it reports', () => {
      // This message reaches a deploy log, which is not a secret store.
      try {
        validateEnv({ ...REQUIRED, PLATFORM_ADMIN_TOKEN: SECRET });
        throw new Error('expected validation to fail');
      } catch (error) {
        expect((error as Error).message).not.toContain(SECRET);
      }
    });
  });

  describe('embedded signup configuration (TAR-161)', () => {
    const CONFIGURED = { META_APP_ID: '1234567890', META_EMBEDDED_SIGNUP_CONFIG_ID: '9876543210' };

    it('is optional, so an environment that does not use the channel still boots', () => {
      // Blank rather than absent, which is what copying `.env.example` verbatim
      // produces. Fail-closed happens at the route, not at boot: requiring these
      // would trade one endpoint's refusal for a global outage.
      const env = validateEnv({
        ...REQUIRED,
        META_APP_ID: '',
        META_EMBEDDED_SIGNUP_CONFIG_ID: '',
      });

      expect(env.META_APP_ID).toBeUndefined();
      expect(env.META_EMBEDDED_SIGNUP_CONFIG_ID).toBeUndefined();
    });

    it('leaves every other setting exactly where it was without them', () => {
      // The absence of a signup config must not reach any other route: the
      // webhook secret, the Graph client and the token key are untouched.
      const withSignup = validateEnv({ ...REQUIRED, ...CONFIGURED });
      const withoutSignup = validateEnv({ ...REQUIRED });

      expect({ ...withSignup, ...CONFIGURED }).toEqual({ ...withoutSignup, ...CONFIGURED });
    });

    it('boots in production with neither of them', () => {
      expect(() => validateEnv({ ...REQUIRED, NODE_ENV: 'production' })).not.toThrow();
    });

    it('keeps the ids as strings, because a Meta id exceeds MAX_SAFE_INTEGER', () => {
      const env = validateEnv({ ...REQUIRED, ...CONFIGURED });

      expect(env.META_APP_ID).toBe(CONFIGURED.META_APP_ID);
      expect(env.META_EMBEDDED_SIGNUP_CONFIG_ID).toBe(CONFIGURED.META_EMBEDDED_SIGNUP_CONFIG_ID);
    });

    it('refuses a value that is not a Meta id', () => {
      // A failed boot beats a Graph call that fails per request, in the one flow
      // whose credential expires in 30 seconds and cannot be retried.
      expect(() => validateEnv({ ...REQUIRED, META_APP_ID: 'my-app' })).toThrow(/META_APP_ID/);
      expect(() => validateEnv({ ...REQUIRED, META_EMBEDDED_SIGNUP_CONFIG_ID: '98 76' })).toThrow(
        /META_EMBEDDED_SIGNUP_CONFIG_ID/,
      );
    });
  });
  describe('the secrets encryption key (TAR-816)', () => {
    /** 32 bytes, base64. A test fixture, and obviously not a key from a CSPRNG. */
    const KEY = Buffer.alloc(32, 7).toString('base64');
    const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

    it('accepts the new name on its own', () => {
      expect(validateEnv({ ...REQUIRED, SECRETS_ENCRYPTION_KEY: KEY }).SECRETS_ENCRYPTION_KEY).toBe(
        KEY,
      );
    });

    it('still accepts the deprecated alias on its own, so a deploy need not move both at once', () => {
      const env = validateEnv({ ...REQUIRED, WHATSAPP_TOKEN_ENCRYPTION_KEY: KEY });

      expect(env.WHATSAPP_TOKEN_ENCRYPTION_KEY).toBe(KEY);
      expect(env.SECRETS_ENCRYPTION_KEY).toBeUndefined();
    });

    it('accepts both when they hold the same key, which is the transition state', () => {
      expect(() =>
        validateEnv({
          ...REQUIRED,
          SECRETS_ENCRYPTION_KEY: KEY,
          WHATSAPP_TOKEN_ENCRYPTION_KEY: KEY,
        }),
      ).not.toThrow();
    });

    it('refuses to boot when the two names hold different keys', () => {
      // Half the readers would take one key and half the other, and the rows
      // written in between would be unreadable by whichever was wrong. A failed
      // deploy the previous instance serves through beats that.
      expect(() =>
        validateEnv({
          ...REQUIRED,
          SECRETS_ENCRYPTION_KEY: KEY,
          WHATSAPP_TOKEN_ENCRYPTION_KEY: OTHER_KEY,
        }),
      ).toThrow(/SECRETS_ENCRYPTION_KEY/);
    });

    it('never puts a key into the failure message', () => {
      try {
        validateEnv({
          ...REQUIRED,
          SECRETS_ENCRYPTION_KEY: KEY,
          WHATSAPP_TOKEN_ENCRYPTION_KEY: OTHER_KEY,
        });
        throw new Error('expected validation to fail');
      } catch (error) {
        expect((error as Error).message).not.toContain(KEY);
        expect((error as Error).message).not.toContain(OTHER_KEY);
      }
    });

    it('refuses a key that is not 32 bytes of base64, under either name', () => {
      const short = Buffer.alloc(16, 7).toString('base64');

      expect(() => validateEnv({ ...REQUIRED, SECRETS_ENCRYPTION_KEY: short })).toThrow(
        /SECRETS_ENCRYPTION_KEY/,
      );
      expect(() => validateEnv({ ...REQUIRED, WHATSAPP_TOKEN_ENCRYPTION_KEY: short })).toThrow(
        /WHATSAPP_TOKEN_ENCRYPTION_KEY/,
      );
    });

    it('boots with neither, because an environment that stores no secret still runs', () => {
      expect(() => validateEnv({ ...REQUIRED, NODE_ENV: 'production' })).not.toThrow();
    });
  });

  describe('the platform settings refresh interval (TAR-816)', () => {
    it('defaults to the interval the existing sweeps use', () => {
      expect(validateEnv({ ...REQUIRED }).PLATFORM_SETTINGS_REFRESH_MS).toBe(30_000);
    });

    it('refuses an interval short enough to be a per-request read in disguise', () => {
      expect(() => validateEnv({ ...REQUIRED, PLATFORM_SETTINGS_REFRESH_MS: '10' })).toThrow(
        /PLATFORM_SETTINGS_REFRESH_MS/,
      );
    });
  });
});
