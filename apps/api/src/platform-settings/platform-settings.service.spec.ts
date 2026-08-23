import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AesGcmCipher } from '../common/security/aes-gcm.cipher';
import {
  PlatformSettingValueInvalidError,
  PlatformSettingsEncryptionUnavailableError,
  UnknownPlatformSettingError,
} from './platform-settings.errors';
import type {
  PlatformSettingsRepository,
  StoredPlatformSetting,
} from './platform-settings.repository';
import { PlatformSettingsService } from './platform-settings.service';

/**
 * What this class promises, in the order the promises matter.
 *
 * The first block is the one the whole feature rests on: an environment that has
 * written no row must behave exactly as it did before this feature existed. The
 * rest is what happens once a row exists — including the two failure modes that
 * were designed rather than defaulted, an undecryptable row and an unrecognised
 * key.
 */

/** 32 bytes, base64. A test fixture, and obviously not a key from a CSPRNG. */
const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

const ENV_APP_SECRET = 'app-secret-from-the-environment-0123';
const ROW_APP_SECRET = 'app-secret-from-the-database-01234567';
const APP_ID = '1234567890123456';

const ACTOR = 'ops-alice';

function fingerprintOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

function row(key: string, value: string, key32 = KEY): StoredPlatformSetting {
  return {
    key,
    valueEncrypted: new AesGcmCipher(() => key32).encrypt(value, `platform_setting:${key}`),
    fingerprint: fingerprintOf(value),
    updatedAt: new Date('2026-08-23T09:00:00.000Z'),
    updatedByLabel: ACTOR,
  };
}

interface Harness {
  service: PlatformSettingsService;
  set: jest.Mock;
  clear: jest.Mock;
  listAll: jest.Mock;
}

function build(options: {
  env?: Record<string, unknown>;
  rows?: StoredPlatformSetting[];
  key?: string | undefined;
}): Harness {
  const env: Record<string, unknown> = {
    PLATFORM_SETTINGS_REFRESH_MS: 30_000,
    ...('key' in options
      ? { SECRETS_ENCRYPTION_KEY: options.key }
      : { SECRETS_ENCRYPTION_KEY: KEY }),
    ...options.env,
  };

  const config = { get: (name: string) => env[name] } as unknown as ConfigService;

  const listAll = jest.fn().mockResolvedValue(options.rows ?? []);
  const set = jest.fn().mockResolvedValue(undefined);
  const clear = jest.fn().mockResolvedValue(true);

  const repository = {
    listAll,
    set,
    clear,
    listChanges: jest.fn().mockResolvedValue([]),
  } as unknown as PlatformSettingsRepository;

  return { service: new PlatformSettingsService(config, repository), listAll, set, clear };
}

async function started(options: Parameters<typeof build>[0]): Promise<Harness> {
  const harness = build(options);

  await harness.service.onModuleInit();

  return harness;
}

describe('PlatformSettingsService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('an environment that has written no row', () => {
    it('serves every key from its environment variable', async () => {
      const { service } = await started({ env: { WHATSAPP_APP_SECRET: ENV_APP_SECRET } });

      expect(service.get('whatsapp.app_secret')).toBe(ENV_APP_SECRET);
      service.onModuleDestroy();
    });

    it('reports a key the environment does not set as unset, not as empty', async () => {
      // The distinction is what the console renders: "Not set" is an action, and
      // an empty string beside `isSet: true` is a bug report.
      const { service } = await started({});

      expect(service.get('whatsapp.app_secret')).toBeNull();
      expect(service.describe('whatsapp.app_secret')).toMatchObject({
        source: 'unset',
        isSet: false,
        fingerprint: null,
        hint: null,
      });
      service.onModuleDestroy();
    });

    it('treats a blank environment variable as unset', async () => {
      const { service } = await started({ env: { WHATSAPP_APP_SECRET: '' } });

      expect(service.get('whatsapp.app_secret')).toBeNull();
      service.onModuleDestroy();
    });

    it('serves the environment even before the first load, so nothing races the boot', () => {
      // `onModuleInit` runs before the app listens, but another provider's
      // `onModuleInit` could read first — and the answer it gets must be today's
      // behaviour rather than `unset`.
      const { service } = build({ env: { WHATSAPP_APP_SECRET: ENV_APP_SECRET } });

      expect(service.get('whatsapp.app_secret')).toBe(ENV_APP_SECRET);
    });
  });

  describe('once a row exists', () => {
    it('overrides the environment', async () => {
      const { service } = await started({
        env: { WHATSAPP_APP_SECRET: ENV_APP_SECRET },
        rows: [row('whatsapp.app_secret', ROW_APP_SECRET)],
      });

      expect(service.get('whatsapp.app_secret')).toBe(ROW_APP_SECRET);
      service.onModuleDestroy();
    });

    it('says so, because the override is otherwise invisible to an operator', async () => {
      const { service } = await started({
        env: { WHATSAPP_APP_SECRET: ENV_APP_SECRET },
        rows: [row('whatsapp.app_secret', ROW_APP_SECRET)],
      });

      expect(service.describe('whatsapp.app_secret')).toMatchObject({
        source: 'database',
        isSet: true,
        updatedByLabel: ACTOR,
        updatedAt: '2026-08-23T09:00:00.000Z',
      });
      service.onModuleDestroy();
    });
  });

  describe('a row that does not decrypt', () => {
    it('reads as unset rather than falling back to the environment', async () => {
      // Falling back would silently re-arm a secret the operator believed they
      // had replaced. Fail closed on the one key instead.
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const { service } = await started({
        env: { WHATSAPP_APP_SECRET: ENV_APP_SECRET },
        rows: [row('whatsapp.app_secret', ROW_APP_SECRET, OTHER_KEY)],
      });

      expect(service.get('whatsapp.app_secret')).toBeNull();
      service.onModuleDestroy();
    });

    it('does not stop the rest of the snapshot loading', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const { service } = await started({
        rows: [row('whatsapp.app_secret', ROW_APP_SECRET, OTHER_KEY), row('meta.app_id', APP_ID)],
      });

      expect(service.get('meta.app_id')).toBe(APP_ID);
      service.onModuleDestroy();
    });

    it('names the key in the log and never the payload', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const { service } = await started({
        rows: [row('whatsapp.app_secret', ROW_APP_SECRET, OTHER_KEY)],
      });

      const [message] = error.mock.calls[0] as [string];

      expect(message).toContain('whatsapp.app_secret');
      expect(message).not.toContain(ROW_APP_SECRET);
      service.onModuleDestroy();
    });
  });

  describe('a row whose key is not in the registry', () => {
    it('is ignored, so a rogue row cannot introduce a managed key', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const { service } = await started({ rows: [row('database.url', 'postgres://nope')] });

      expect(service.describeAll().map((view) => view.key)).not.toContain('database.url');
      expect(warn).toHaveBeenCalled();
      service.onModuleDestroy();
    });
  });

  describe('what a read may reveal', () => {
    it('never returns a secret plaintext, whatever its source', async () => {
      const { service } = await started({
        env: { WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'a-verify-token-of-sufficient-length' },
        rows: [row('whatsapp.app_secret', ROW_APP_SECRET)],
      });

      for (const view of service.describeAll().filter((v) => v.sensitivity === 'secret')) {
        expect(view.value).toBeUndefined();
      }

      // The whole serialized response, so nothing reaches a client by another
      // field name either.
      expect(JSON.stringify(service.describeAll())).not.toContain(ROW_APP_SECRET);
      service.onModuleDestroy();
    });

    it('returns a public value, because it already reaches every browser', async () => {
      const { service } = await started({ rows: [row('meta.app_id', APP_ID)] });

      expect(service.describe('meta.app_id').value).toBe(APP_ID);
      service.onModuleDestroy();
    });

    it('publishes a fingerprint for an environment-sourced value too', async () => {
      // It is how an operator compares two environments, and an environment
      // value has no row to carry one.
      const { service } = await started({ env: { WHATSAPP_APP_SECRET: ENV_APP_SECRET } });

      expect(service.describe('whatsapp.app_secret')).toMatchObject({
        source: 'environment',
        fingerprint: fingerprintOf(ENV_APP_SECRET),
        updatedAt: null,
        updatedByLabel: null,
      });
      service.onModuleDestroy();
    });

    it('hints at the last four characters only when the value is long enough', async () => {
      const { service } = await started({
        env: { WHATSAPP_APP_SECRET: ENV_APP_SECRET, META_APP_ID: '1234567890' },
      });

      expect(service.describe('whatsapp.app_secret').hint).toBe(ENV_APP_SECRET.slice(-4));
      // Ten characters: four of them would be a meaningful fraction of the value.
      expect(service.describe('meta.app_id').hint).toBeNull();
      service.onModuleDestroy();
    });

    it('lists every registry key, including the ones nobody has touched', async () => {
      const { service } = await started({});

      expect(service.describeAll()).toHaveLength(4);
      service.onModuleDestroy();
    });

    it('refuses a key it does not manage', async () => {
      const { service } = await started({});

      expect(() => service.describe('database.url')).toThrow(UnknownPlatformSettingError);
      service.onModuleDestroy();
    });
  });

  describe('writing a value', () => {
    it('encrypts it bound to the key, and stores a fingerprint of the plaintext', async () => {
      const { service, set } = await started({});

      await service.set('meta.app_id', APP_ID, ACTOR);

      const [write] = set.mock.calls[0] as [
        { key: string; valueEncrypted: string; fingerprint: string; actorLabel: string },
      ];

      expect(write).toMatchObject({
        key: 'meta.app_id',
        fingerprint: fingerprintOf(APP_ID),
        actorLabel: ACTOR,
      });
      expect(write.valueEncrypted).not.toContain(APP_ID);
      expect(
        new AesGcmCipher(() => KEY).decrypt(write.valueEncrypted, 'platform_setting:meta.app_id'),
      ).toBe(APP_ID);
      service.onModuleDestroy();
    });

    it('takes effect on this instance immediately, which is why no restart is needed', async () => {
      const harness = await started({});

      harness.listAll.mockResolvedValue([row('meta.app_id', APP_ID)]);
      await harness.service.set('meta.app_id', APP_ID, ACTOR);

      expect(harness.service.get('meta.app_id')).toBe(APP_ID);
      harness.service.onModuleDestroy();
    });

    it('refuses a value the registry schema rejects, before anything is encrypted', async () => {
      const { service, set } = await started({});

      await expect(service.set('meta.app_id', 'my-app', ACTOR)).rejects.toThrow(
        PlatformSettingValueInvalidError,
      );
      expect(set).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('does not echo the submitted value in the refusal', async () => {
      // An error body is a place a secret ends up in a browser console, a
      // screenshot and a support ticket.
      const { service } = await started({});

      const error = await service
        .set('whatsapp.app_secret', 'too-short', ACTOR)
        .catch((thrown: unknown) => thrown);

      expect((error as Error).message).not.toContain('too-short');
      service.onModuleDestroy();
    });

    it('refuses a key it does not manage', async () => {
      const { service, set } = await started({});

      await expect(service.set('database.url', 'postgres://nope', ACTOR)).rejects.toThrow(
        UnknownPlatformSettingError,
      );
      expect(set).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('refuses to store anything when no encryption key is configured', async () => {
      // The alternative is a credential in clear text. Reads keep working from
      // the environment, which is the same shape the WhatsApp channel has.
      const { service, set } = await started({ key: undefined });

      await expect(service.set('meta.app_id', APP_ID, ACTOR)).rejects.toThrow(
        PlatformSettingsEncryptionUnavailableError,
      );
      expect(set).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });
  });

  describe('reverting to the environment', () => {
    it('deletes the row and resolves from the environment again', async () => {
      const harness = await started({
        env: { WHATSAPP_APP_SECRET: ENV_APP_SECRET },
        rows: [row('whatsapp.app_secret', ROW_APP_SECRET)],
      });

      harness.listAll.mockResolvedValue([]);
      const view = await harness.service.clear('whatsapp.app_secret', ACTOR);

      expect(harness.clear).toHaveBeenCalledWith('whatsapp.app_secret', ACTOR);
      expect(view.source).toBe('environment');
      expect(harness.service.get('whatsapp.app_secret')).toBe(ENV_APP_SECRET);
      harness.service.onModuleDestroy();
    });

    it('is a no-op on a key that has no row', async () => {
      const harness = await started({});

      harness.clear.mockResolvedValue(false);

      await expect(harness.service.clear('meta.app_id', ACTOR)).resolves.toMatchObject({
        source: 'unset',
      });
      harness.service.onModuleDestroy();
    });
  });

  describe('when the database is unreachable', () => {
    it('does not fail the boot — it serves the environment and retries', async () => {
      // A settings-table outage must not become a total API outage when the
      // environment already carries working values. This is the one place the
      // design degrades rather than failing closed, because the degraded state
      // *is* the pre-feature behaviour.
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const harness = build({ env: { WHATSAPP_APP_SECRET: ENV_APP_SECRET } });

      harness.listAll.mockRejectedValue(new Error('connection refused'));

      await expect(harness.service.onModuleInit()).resolves.toBeUndefined();
      expect(harness.service.get('whatsapp.app_secret')).toBe(ENV_APP_SECRET);
      harness.service.onModuleDestroy();
    });

    it('keeps serving the previous snapshot when a later refresh fails', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const harness = await started({ rows: [row('meta.app_id', APP_ID)] });

      harness.listAll.mockRejectedValue(new Error('connection refused'));
      await harness.service.set('meta.app_id', APP_ID, ACTOR).catch(() => undefined);

      expect(harness.service.get('meta.app_id')).toBe(APP_ID);
      harness.service.onModuleDestroy();
    });
  });

  describe('the refresh timer', () => {
    it('reloads on the configured interval, which is the platform-wide bound', async () => {
      jest.useFakeTimers();

      try {
        const harness = build({ env: { PLATFORM_SETTINGS_REFRESH_MS: 1_000 } });

        await harness.service.onModuleInit();
        expect(harness.listAll).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(3_000);
        expect(harness.listAll).toHaveBeenCalledTimes(4);

        harness.service.onModuleDestroy();
        jest.advanceTimersByTime(3_000);
        expect(harness.listAll).toHaveBeenCalledTimes(4);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
