import { createHash } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PlatformSettingChangeView,
  PlatformSettingSource,
  PlatformSettingView,
} from '@whatsappcrm/contracts';
import {
  AesGcmCipher,
  AesGcmKeyUnavailableError,
  AesGcmUndecryptableError,
} from '../common/security/aes-gcm.cipher';
import { readSecretsEncryptionKey } from '../common/security/secrets-encryption-key';
import {
  PlatformSettingValueInvalidError,
  PlatformSettingsEncryptionUnavailableError,
  UnknownPlatformSettingError,
} from './platform-settings.errors';
import {
  PLATFORM_SETTINGS,
  platformSettingDefinition,
  type PlatformSettingDefinition,
  type PlatformSettingKey,
} from './platform-settings.registry';
import {
  PlatformSettingsRepository,
  type StoredPlatformSetting,
  type StoredPlatformSettingChange,
} from './platform-settings.repository';

/** How many history entries a key's history endpoint returns. See `listChanges` for why it is a cap. */
const HISTORY_LIMIT = 50;

/** SHA-256 hex characters kept as a fingerprint. Matches `platform_settings.fingerprint`, `char(8)`. */
const FINGERPRINT_LENGTH = 8;

/** Characters of the plaintext a `hint` reveals, and the length below which it reveals none. */
const HINT_LENGTH = 4;
const HINT_MIN_PLAINTEXT_LENGTH = 12;

/** How long a refresh may keep failing before the log line escalates from `warn` to `error`. */
const REFRESH_FAILURE_ESCALATION_MS = 5 * 60 * 1_000;

/** One key's effective value and where it came from. */
interface ResolvedSetting {
  value: string | null;
  source: PlatformSettingSource;
  /** Null when unset. Computed from the effective plaintext, whatever its source. */
  fingerprint: string | null;
  /** Null unless `source` is `database` — an environment variable has no change stamp. */
  updatedAt: Date | null;
  updatedByLabel: string | null;
}

/**
 * The runtime value of every managed platform setting (TAR-816, against
 * TAR-811's contract).
 *
 * ## Why this holds a snapshot rather than reading a row per use
 *
 * `WebhookIngestService.verifyHandshake` is synchronous and `ingestWhatsApp`
 * reads the app secret before it verifies a signature — on a public,
 * unthrottled route that Meta retries and eventually gives up on. Replacing
 * those reads with an awaited database call would change both signatures and
 * add a round trip to every inbound delivery. So `get()` is synchronous and
 * answers from memory, and the memory is loaded once at boot rather than warmed
 * lazily, which would put an unbounded first-request penalty on a signature
 * check.
 *
 * ## Resolution, and what "unset" means
 *
 * `database row → environment variable → unset`, per key. An environment that
 * never writes a row behaves exactly as it did before this class existed, which
 * is the property that made database-overrides-environment the right way round.
 *
 * A row that **does not decrypt** resolves to `unset`, *not* to the environment
 * fallback. Falling back would silently re-arm a secret the operator believed
 * they had replaced. One key fails closed; the rest of the snapshot loads.
 *
 * A row whose key is not in the registry is ignored and logged — that is what
 * makes the allowlist closed at the read, so a rogue row cannot introduce a
 * managed key.
 *
 * ## What it never does
 *
 * No decrypted value reaches a log line, an error message, a DTO or a history
 * row. Errors name the **key**; the payload is never named, at any level.
 */
@Injectable()
export class PlatformSettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformSettingsService.name);
  private readonly cipher: AesGcmCipher;

  /**
   * Seeded from the environment in the constructor rather than left empty until
   * `onModuleInit`, so a read that somehow lands before the first load — another
   * provider's `onModuleInit`, a health probe racing boot — sees today's
   * behaviour instead of `unset`.
   */
  private snapshot: ReadonlyMap<string, ResolvedSetting>;

  private timer: NodeJS.Timeout | null = null;
  private consecutiveRefreshFailures = 0;

  /**
   * Reloads run one at a time, in call order.
   *
   * Two can otherwise overlap — a timer tick issues its `listAll()`, a write
   * arrives and reloads while that read is still outstanding — and the older
   * result can land last, reinstating the pre-write row set. `get()` on this
   * instance would then serve the superseded secret until the next tick, which
   * contradicts the "effective on the writing instance by the time it answers"
   * property the whole synchronous-`get()` design is justified by. It would also
   * count one outage twice against the escalation threshold.
   *
   * Serialising rather than joining the in-flight load, because a write must
   * observe its own commit: a read that *started* before the commit is not an
   * acceptable answer for the reload that follows it, however recent it is.
   */
  private reloadChain: Promise<unknown> = Promise.resolve();

  /** True while a reload is running, so a timer tick can skip rather than queue. */
  private reloading = false;

  constructor(
    private readonly config: ConfigService,
    private readonly repository: PlatformSettingsRepository,
  ) {
    this.cipher = new AesGcmCipher(() => readSecretsEncryptionKey(this.config));
    this.snapshot = this.resolve([]);
  }

  /**
   * Loads the snapshot **before the app listens**, so no request can observe an
   * unresolved key, and starts the refresh timer.
   */
  async onModuleInit(): Promise<void> {
    // `atBoot` so this one failure logs at `error` immediately. Every later tick
    // stays rate-limited — but an instance that came up unable to read the table
    // is serving every key from the environment, which for a rotated secret is
    // the superseded one, and that must not wait five minutes to be visible.
    await this.reload({ atBoot: true });

    const interval = this.config.get<number>('PLATFORM_SETTINGS_REFRESH_MS') ?? 30_000;

    // `unref` so a pending tick cannot hold the process open: a settings refresh
    // is never the reason to delay a shutdown.
    this.timer = setInterval(() => {
      // Skipped rather than queued while one is running: a tick that waits out a
      // slow read has nothing to add by the time it gets its turn, and queueing
      // them would turn a slow database into a backlog.
      if (!this.reloading) {
        void this.reload();
      }
    }, interval);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * The effective value, or `null` when the key is unset.
   *
   * **Synchronous by design** — see the class comment. It reads the in-memory
   * snapshot and never touches the database or decrypts on this path.
   */
  get(key: PlatformSettingKey): string | null {
    return this.snapshot.get(key)?.value ?? null;
  }

  /** What the admin surface renders. Never carries a `secret` plaintext. */
  describe(key: string): PlatformSettingView {
    const definition = platformSettingDefinition(key);

    if (definition === null) {
      throw new UnknownPlatformSettingError(key);
    }

    return this.view(definition);
  }

  /**
   * One entry per **registry** key, including unset ones — the registry is the
   * list, not the table, so a key nobody has touched still appears.
   */
  describeAll(): PlatformSettingView[] {
    return PLATFORM_SETTINGS.map((definition) => this.view(definition));
  }

  /**
   * Validates, encrypts, upserts, appends history and reloads the local
   * snapshot.
   *
   * The reload is what makes the write effective on this instance immediately;
   * every other instance picks it up within `PLATFORM_SETTINGS_REFRESH_MS`. That
   * bound is what the admin console quotes to the operator, and it is the reason
   * this feature needs no restart.
   *
   * **If that reload fails, the write still happened**, so the snapshot is
   * updated from what was committed rather than left holding the previous value.
   * Reporting the pre-write view would tell the operator their save did not take
   * while it is committed and about to be live platform-wide — and TAR-817's
   * confirmation reads exactly the fields that would be wrong.
   */
  async set(key: string, value: string, actorLabel: string): Promise<PlatformSettingView> {
    const definition = this.require(key);

    if (!this.cipher.isConfigured) {
      throw new PlatformSettingsEncryptionUnavailableError();
    }

    const parsed = definition.schema.safeParse(value);

    if (!parsed.success) {
      // The schema's own message, which is a rule. The submitted value is never
      // echoed — an error body is a place a secret ends up in a browser console.
      throw new PlatformSettingValueInvalidError(
        definition.key,
        parsed.error.issues[0]?.message ?? 'failed validation',
      );
    }

    const fingerprint = fingerprintOf(parsed.data);
    const updatedAt = await this.repository.set({
      key: definition.key,
      valueEncrypted: this.encrypt(definition.key, parsed.data),
      fingerprint,
      actorLabel,
    });

    if (!(await this.reload())) {
      this.apply(definition.key, {
        value: parsed.data,
        source: 'database',
        fingerprint,
        updatedAt,
        updatedByLabel: actorLabel,
      });
    }

    return this.view(definition);
  }

  /**
   * Deletes the row so the key resolves from its environment variable again.
   *
   * Idempotent: clearing a key that has no row reports the same state it
   * already had. The console's affordance for this is "Revert to environment",
   * which is the only thing that makes database-overrides-environment visible.
   *
   * A failed reload is handled as it is on `set`: the delete committed, so the
   * key resolves from its environment variable now, and that is what is reported
   * rather than the database value that is gone.
   */
  async clear(key: string, actorLabel: string): Promise<PlatformSettingView> {
    const definition = this.require(key);

    await this.repository.clear(definition.key, actorLabel);

    if (!(await this.reload())) {
      this.apply(definition.key, this.resolveOne(definition, undefined));
    }

    return this.view(definition);
  }

  /** A key's change history, newest first. Fingerprints and actor labels; never values. */
  async history(key: string): Promise<PlatformSettingChangeView[]> {
    const definition = this.require(key);
    const changes = await this.repository.listChanges(definition.key, HISTORY_LIMIT);

    return changes.map(toChangeView);
  }

  private require(key: string): PlatformSettingDefinition {
    const definition = platformSettingDefinition(key);

    if (definition === null) {
      throw new UnknownPlatformSettingError(key);
    }

    return definition;
  }

  /**
   * Reads every stored override and rebuilds the snapshot, one reload at a time.
   *
   * Returns whether **this call's own read** applied, which is what the write
   * paths branch on — a `false` there means the value is committed but the
   * snapshot has not caught up, and they install what they wrote.
   *
   * **A failure keeps the previous snapshot.** At boot that is the
   * environment-seeded one, which is the pre-feature behaviour — a settings
   * table outage must not become a total API outage when the environment already
   * carries working values. On a later tick it is the last good load, because
   * staleness on a value that has not changed is strictly better than losing it.
   */
  private reload(options: { atBoot?: boolean } = {}): Promise<boolean> {
    // Chained rather than fired concurrently, so results apply in call order and
    // a write's reload always issues its `listAll()` after the commit it follows.
    // `load` never rejects, so the chain cannot break.
    const next = this.reloadChain.then(() => this.load(options.atBoot ?? false));

    this.reloadChain = next;

    return next;
  }

  private async load(atBoot: boolean): Promise<boolean> {
    this.reloading = true;

    try {
      this.snapshot = this.resolve(await this.repository.listAll());
      this.consecutiveRefreshFailures = 0;

      return true;
    } catch (error: unknown) {
      this.reportRefreshFailure(error, atBoot);

      return false;
    } finally {
      this.reloading = false;
    }
  }

  /**
   * Replaces one key's entry, leaving the rest of the snapshot alone.
   *
   * Only ever called after a committed write whose reload could not confirm it —
   * see `set`. The snapshot is replaced rather than mutated so a reader holding
   * the previous map is unaffected mid-request.
   */
  private apply(key: string, resolved: ResolvedSetting): void {
    this.snapshot = new Map(this.snapshot).set(key, resolved);
  }

  /**
   * Escalates from `warn` to `error` once the snapshot has been stale for five
   * minutes, which is the one alert worth defining on this feature.
   *
   * Rate-limited rather than logged per tick: a database outage would otherwise
   * emit a line every `PLATFORM_SETTINGS_REFRESH_MS` for as long as it lasts,
   * and the signal that matters is "still failing", not "failed again".
   *
   * **The boot load is the exception and logs `error` on the first attempt.** An
   * instance that came up unable to read the table serves every key from the
   * environment — for a key an operator has rotated through the admin surface,
   * that is the superseded value — and waiting out ten quiet ticks before saying
   * so is five minutes of a credential nobody knows is stale.
   */
  private reportRefreshFailure(error: unknown, atBoot: boolean): void {
    this.consecutiveRefreshFailures += 1;

    const interval = this.config.get<number>('PLATFORM_SETTINGS_REFRESH_MS') ?? 30_000;
    const escalateEvery = Math.max(1, Math.ceil(REFRESH_FAILURE_ESCALATION_MS / interval));
    const reason = error instanceof Error ? error.message : 'unknown error';

    if (atBoot) {
      this.logger.error(
        `Could not load the platform settings snapshot at boot: ${reason}. Every managed key is ` +
          'resolving from its environment variable, so a value an operator has changed through ' +
          'the admin surface is not in effect on this instance. Retrying on the refresh timer.',
      );
      return;
    }

    if (this.consecutiveRefreshFailures === 1) {
      this.logger.warn(
        `Could not refresh the platform settings snapshot: ${reason}. Serving the previous ` +
          'snapshot; retrying on the next tick.',
      );
      return;
    }

    if (this.consecutiveRefreshFailures % escalateEvery === 0) {
      this.logger.error(
        `The platform settings snapshot has not refreshed for ${this.consecutiveRefreshFailures} ` +
          `consecutive attempts: ${reason}. Managed values are stale.`,
      );
    }
  }

  /**
   * Builds the per-key resolution from the stored rows plus the environment.
   *
   * Rows are matched against the registry rather than the other way round, so an
   * unrecognised key is reported once per load and then ignored.
   */
  private resolve(stored: readonly StoredPlatformSetting[]): ReadonlyMap<string, ResolvedSetting> {
    const byKey = new Map(stored.map((row) => [row.key, row]));

    for (const key of byKey.keys()) {
      if (platformSettingDefinition(key) === null) {
        this.logger.warn(
          `Ignoring the platform_settings row \`${key}\`: it is not in the registry, so it names ` +
            'no managed setting. Remove the row, or add the key in platform-settings.registry.ts.',
        );
      }
    }

    return new Map(
      PLATFORM_SETTINGS.map((definition) => [
        definition.key,
        this.resolveOne(definition, byKey.get(definition.key)),
      ]),
    );
  }

  private resolveOne(
    definition: PlatformSettingDefinition,
    row: StoredPlatformSetting | undefined,
  ): ResolvedSetting {
    if (row !== undefined) {
      const value = this.decrypt(definition.key, row.valueEncrypted);

      if (value === null) {
        // Fail closed on this one key. Falling back to the environment would
        // silently re-arm a value the operator believed they had replaced, and
        // the operator's one action either way is to re-enter it.
        return unset();
      }

      return {
        value,
        source: 'database',
        fingerprint: row.fingerprint,
        updatedAt: row.updatedAt,
        updatedByLabel: row.updatedByLabel,
      };
    }

    const fromEnvironment = this.config.get<string>(definition.envVar);

    if (fromEnvironment === undefined || fromEnvironment.length === 0) {
      return unset();
    }

    return {
      value: fromEnvironment,
      source: 'environment',
      // Computed rather than stored: an environment-sourced value has no row to
      // carry one, and the console compares environments by this field.
      fingerprint: fingerprintOf(fromEnvironment),
      updatedAt: null,
      updatedByLabel: null,
    };
  }

  private encrypt(key: string, plaintext: string): string {
    try {
      return this.cipher.encrypt(plaintext, aadFor(key));
    } catch (error: unknown) {
      if (error instanceof AesGcmKeyUnavailableError) {
        throw new PlatformSettingsEncryptionUnavailableError();
      }

      throw error;
    }
  }

  /** The plaintext, or `null` when the row does not decrypt. Never logs the payload. */
  private decrypt(key: string, payload: string): string | null {
    try {
      return this.cipher.decrypt(payload, aadFor(key));
    } catch (error: unknown) {
      if (error instanceof AesGcmUndecryptableError) {
        this.logger.error(
          `The stored value for \`${key}\` could not be decrypted, so the setting reads as unset. ` +
            'The encryption key may have been rotated. Re-enter the value through the admin ' +
            'settings surface.',
        );
        return null;
      }

      if (error instanceof AesGcmKeyUnavailableError) {
        this.logger.error(
          `The stored value for \`${key}\` cannot be read: SECRETS_ENCRYPTION_KEY is not ` +
            'configured in this environment.',
        );
        return null;
      }

      throw error;
    }
  }

  private view(definition: PlatformSettingDefinition): PlatformSettingView {
    const resolved = this.snapshot.get(definition.key) ?? unset();

    return {
      key: definition.key,
      description: definition.description,
      sensitivity: definition.sensitivity,
      source: resolved.source,
      isSet: resolved.source !== 'unset',
      // The one place a plaintext can leave this class, and it is gated on the
      // registry's classification rather than on anything a row could carry.
      // Absent rather than null for a secret: `null` beside `isSet: true` would
      // read as "set to nothing".
      ...(definition.sensitivity === 'public' && resolved.value !== null
        ? { value: resolved.value }
        : {}),
      fingerprint: resolved.fingerprint,
      hint: hintFor(resolved.value),
      updatedAt: resolved.updatedAt?.toISOString() ?? null,
      updatedByLabel: resolved.updatedByLabel,
    };
  }
}

function unset(): ResolvedSetting {
  return {
    value: null,
    source: 'unset',
    fingerprint: null,
    updatedAt: null,
    updatedByLabel: null,
  };
}

/**
 * The AAD every stored value is bound to.
 *
 * Bound to the **key** rather than to the row's uuid, so a delete-then-recreate
 * of the same key still decrypts while a ciphertext copied from another key's
 * row does not — the two are read by different code paths with different
 * exposure, and someone with database write access must not be able to promote
 * the app secret's ciphertext into the app id's row.
 */
function aadFor(key: string): string {
  return `platform_setting:${key}`;
}

/**
 * First 8 hex characters of SHA-256 of the plaintext.
 *
 * Comparable across environments without either of them returning the value.
 * Safe to publish only because every key carries a write-time length floor —
 * see `SECRET_MIN_LENGTH` in the registry.
 */
function fingerprintOf(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * The last four characters, and only for a value long enough that four of them
 * are not a meaningful fraction of it.
 *
 * It is what lets an operator confirm they pasted the right secret without the
 * API ever returning one.
 */
function hintFor(plaintext: string | null): string | null {
  if (plaintext === null || plaintext.length < HINT_MIN_PLAINTEXT_LENGTH) {
    return null;
  }

  return plaintext.slice(-HINT_LENGTH);
}

function toChangeView(change: StoredPlatformSettingChange): PlatformSettingChangeView {
  return {
    id: change.id,
    key: change.key,
    action: change.action,
    previousFingerprint: change.previousFingerprint,
    newFingerprint: change.newFingerprint,
    actorLabel: change.actorLabel,
    createdAt: change.createdAt.toISOString(),
  };
}
