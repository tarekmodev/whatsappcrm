import { Inject, Injectable } from '@nestjs/common';
import { PlatformSettingChangeAction } from '../generated/prisma/enums';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';

/** One stored override, exactly as the snapshot loader needs it. */
export interface StoredPlatformSetting {
  key: string;
  valueEncrypted: string;
  fingerprint: string;
  updatedAt: Date;
  updatedByLabel: string;
}

/** One history entry, exactly as the history endpoint renders it. */
export interface StoredPlatformSettingChange {
  id: string;
  key: string;
  action: PlatformSettingChangeAction;
  previousFingerprint: string | null;
  newFingerprint: string | null;
  actorLabel: string;
  createdAt: Date;
}

/** What `set` writes, once the value has been validated and encrypted. */
export interface PlatformSettingWrite {
  key: string;
  valueEncrypted: string;
  fingerprint: string;
  actorLabel: string;
}

/**
 * Every read and write of `platform_settings` and `platform_setting_changes`,
 * and the only place in this module `SystemPrisma` is reached from (TAR-816).
 *
 * ## The `SYSTEM_PRISMA` justification
 *
 * `prisma.tokens.ts` confines the unrestricted client to five call sites —
 * provisioning, login before a tenant is known, webhook ingest, the sweeper,
 * platform reporting — and says a sixth needs a justification in review. This is
 * the sixth, and the justification is three-part:
 *
 *   * These tables have **no `tenant_id`**, so `TenantPrisma` would refuse them
 *     outright (`MODEL_POLICIES` marks both `system-only`) and, absent that
 *     rule, the application role holds no grant on them at all. There is no
 *     narrower client that can read them.
 *   * The reads are a **bounded set of platform-scoped rows** keyed by a
 *     code-owned allowlist — single-digit rows, no tenant data, no user input in
 *     any predicate.
 *   * The access is **confined to this one class**, so `SYSTEM_PRISMA` appears
 *     in this constructor and in no other file under `platform-settings/`.
 *
 * Nothing here is tenant-facing, and nothing here decrypts: the ciphertext goes
 * out as it came in, and the key never reaches this layer.
 */
@Injectable()
export class PlatformSettingsRepository {
  constructor(@Inject(SYSTEM_PRISMA) private readonly prisma: SystemPrisma) {}

  /**
   * Every stored override.
   *
   * The whole table, unfiltered and unpaginated, because the registry bounds it
   * to single-digit rows and the snapshot needs all of them at once. Filtering
   * to the registry's keys in SQL would hide the rows this deliberately reports
   * — an unrecognised key is logged at `warn` by the loader, and a predicate
   * here would make it invisible instead.
   *
   * `value_encrypted` is selected because the snapshot decrypts it; nothing else
   * ever selects it.
   */
  listAll(): Promise<StoredPlatformSetting[]> {
    return this.prisma.platformSetting.findMany({
      select: {
        key: true,
        valueEncrypted: true,
        fingerprint: true,
        updatedAt: true,
        updatedByLabel: true,
      },
    });
  }

  /**
   * Writes the value and appends the history entry, in one transaction.
   *
   * The read of the previous fingerprint happens **inside** the transaction
   * rather than from the in-memory snapshot: the snapshot may be up to one
   * refresh interval stale, and a history row claiming the wrong predecessor is
   * worse than no history row at all.
   *
   * `upsert` on the unique `key`, so a repeat write is an update rather than a
   * constraint violation, and the whole operation is idempotent on (key, value).
   */
  async set(write: PlatformSettingWrite): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.platformSetting.findUnique({
        where: { key: write.key },
        select: { fingerprint: true },
      });

      await tx.platformSetting.upsert({
        where: { key: write.key },
        create: {
          key: write.key,
          valueEncrypted: write.valueEncrypted,
          fingerprint: write.fingerprint,
          updatedByLabel: write.actorLabel,
        },
        update: {
          valueEncrypted: write.valueEncrypted,
          fingerprint: write.fingerprint,
          updatedByLabel: write.actorLabel,
        },
        select: { id: true },
      });

      await tx.platformSettingChange.create({
        data: {
          key: write.key,
          action: PlatformSettingChangeAction.set,
          previousFingerprint: previous?.fingerprint ?? null,
          newFingerprint: write.fingerprint,
          actorLabel: write.actorLabel,
        },
        select: { id: true },
      });
    });
  }

  /**
   * Deletes the override so the key resolves from its environment variable
   * again, and records that it happened.
   *
   * Returns `false` when there was no row — the caller reports the resulting
   * state either way, because "already reverted" and "just reverted" leave the
   * key in the same place. No history row is written for the no-op: the trail
   * records changes, and nothing changed.
   */
  async clear(key: string, actorLabel: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.platformSetting.findUnique({
        where: { key },
        select: { fingerprint: true },
      });

      if (previous === null) {
        return false;
      }

      await tx.platformSetting.delete({ where: { key }, select: { id: true } });

      await tx.platformSettingChange.create({
        data: {
          key,
          action: PlatformSettingChangeAction.cleared,
          previousFingerprint: previous.fingerprint,
          newFingerprint: null,
          actorLabel,
        },
        select: { id: true },
      });

      return true;
    });
  }

  /**
   * A key's history, newest first, capped.
   *
   * The cap is a bound rather than a page: this is a settings screen, not a
   * browsable log, and the registry's four keys change a handful of times in a
   * platform's life. `(key, created_at DESC)` covers both the filter and the
   * sort, so the read is an index scan with no sort node.
   */
  listChanges(key: string, take: number): Promise<StoredPlatformSettingChange[]> {
    return this.prisma.platformSettingChange.findMany({
      where: { key },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        key: true,
        action: true,
        previousFingerprint: true,
        newFingerprint: true,
        actorLabel: true,
        createdAt: true,
      },
    });
  }
}
