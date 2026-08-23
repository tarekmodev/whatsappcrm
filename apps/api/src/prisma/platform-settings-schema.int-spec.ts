import { randomUUID } from 'node:crypto';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { PlatformSettingsRepository } from '../platform-settings/platform-settings.repository';
import { createPrismaClient } from './prisma-client.factory';
import { UnscopedModelAccessError } from './prisma.errors';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-816: the parts of `platform_settings` and `platform_setting_changes` that
 * `schema.prisma` cannot express, against a real PostgreSQL.
 *
 * The tables and their columns are ordinary Prisma and `migrate diff` reports
 * drift on them loudly. These will not report anything:
 *
 *   1. **The absence of RLS, and `app-roles.sql` granting the app role nothing.**
 *      Neither table carries `tenant_id`, so no policy could apply and the grant
 *      is the only thing between the tenant connection and the platform's own
 *      Meta app secret. `app-roles.sql` is a bootstrap file rather than a
 *      migration: nothing re-asserts it on deploy except an operator remembering
 *      to re-run it after this migration adds two tables it has never granted.
 *   2. **`platform_setting_changes` being append-only against the owner too.**
 *      The grants withhold UPDATE from both application roles; the trigger is
 *      what covers the table owner, which is the credential a psql session runs
 *      as at 2 a.m. Prisma has no syntax for a trigger and its describer ignores
 *      one, so a dropped trigger is invisible to every tool in the repository.
 *   3. **The repository's transactional guarantees** — that a write records its
 *      predecessor's fingerprint, and that a clear leaves the trail behind while
 *      taking the row. Those are properties of the statements rather than of the
 *      schema, and the reason the previous fingerprint is read inside the
 *      transaction rather than from the in-memory snapshot.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. A handful of
 * `tar816.` keys, deleted before the run as well as after it, so an interrupted
 * run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const REQUEST_ID = 'tar816-int-spec';
const TENANT = '40444444-4444-7444-8444-444444444401';

/** Every fixture row is prefixed with this and removed by it. */
const PREFIX = 'tar816.';

const ACTOR = 'tar816-operator';

/** Ciphertext-shaped, and deliberately not real ciphertext: nothing here decrypts anything. */
function payload(key: string): string {
  return `v1.aXY.dGFn.${key}-ciphertext`;
}

function fingerprint(seed: string): string {
  return seed.padEnd(8, '0').slice(0, 8);
}

describe('platform settings schema', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  /**
   * The table **owner**, and the only connection in this suite that can remove a
   * history row.
   *
   * That is the property under test rather than a workaround: `app-roles.sql`
   * withholds DELETE on `platform_setting_changes` from `whatsappcrm_system`
   * as well as from the app role, so teardown has to run as the owner — exactly
   * as an operator purging the trail would have to.
   */
  let ownerPrisma: PrismaClient;
  let repository: PlatformSettingsRepository;

  function asTenant<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId: TENANT, userId: null },
      async () => await work(),
    );
  }

  async function removeFixture(): Promise<void> {
    await ownerPrisma.platformSettingChange.deleteMany({ where: { key: { startsWith: PREFIX } } });
    await ownerPrisma.platformSetting.deleteMany({ where: { key: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);
    ownerPrisma = createPrismaClient('system', requireEnv('DATABASE_URL'));
    repository = new PlatformSettingsRepository(systemPrisma);

    await removeFixture();
  });

  afterAll(async () => {
    await removeFixture();
    await systemPrisma.$disconnect();
    await tenantBase.$disconnect();
    await ownerPrisma.$disconnect();
  });

  describe('reachability', () => {
    it('carries no tenant_id on either table, so no policy could apply', async () => {
      const columns = await systemPrisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND column_name = 'tenant_id'
           AND table_name IN ('platform_settings', 'platform_setting_changes')
      `;

      expect(columns).toEqual([]);
    });

    it.each(['platform_settings', 'platform_setting_changes'])(
      'grants the app role nothing at all on %s',
      async (table) => {
        // The grant *is* the enforcement here. Asserted on the catalogue as well
        // as behaviourally below, so a partial grant added by hand fails by name.
        const privileges = await systemPrisma.$queryRaw<{ privilege_type: string }[]>`
          SELECT privilege_type FROM information_schema.role_table_grants
           WHERE grantee = 'whatsappcrm_app' AND table_schema = 'public' AND table_name = ${table}
        `;

        expect(privileges).toEqual([]);
      },
    );

    it('refuses a tenant-side read before it reaches a permission failure', async () => {
      // `MODEL_POLICIES` marks both models `system-only`, so code that reached
      // for the wrong client gets a message naming the cause rather than
      // SQLSTATE 42501 three frames deeper.
      await asTenant(async () => {
        await expect(tenantPrisma.platformSetting.findMany()).rejects.toBeInstanceOf(
          UnscopedModelAccessError,
        );
        await expect(tenantPrisma.platformSettingChange.findMany()).rejects.toBeInstanceOf(
          UnscopedModelAccessError,
        );
      });
    });

    it('refuses the tenant connection even with the scope rule bypassed', async () => {
      // The rule above is a message; this is the guarantee. Straight through the
      // un-extended client, which is what a raw query or a future code path
      // would use.
      await expect(
        tenantBase.$queryRawUnsafe('SELECT count(*) FROM platform_settings'),
      ).rejects.toThrow(/permission denied/i);
    });

    it('withholds UPDATE and DELETE on the history from the system role too', async () => {
      // `SystemPrisma` is the credential a mistake would run under, and who
      // changed the platform's Meta app secret is exactly what a trail must keep.
      const privileges = await systemPrisma.$queryRaw<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'whatsappcrm_system'
           AND table_schema = 'public'
           AND table_name = 'platform_setting_changes'
      `;

      expect(privileges.map((row) => row.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
    });
  });

  describe('the history is append-only', () => {
    const key = `${PREFIX}append_only`;
    const rewrite = `UPDATE platform_setting_changes SET actor_label = 'someone-else' WHERE key = '${key}'`;

    beforeAll(async () => {
      await systemPrisma.platformSettingChange.create({
        data: {
          id: randomUUID(),
          key,
          action: 'set',
          previousFingerprint: null,
          newFingerprint: fingerprint('aaaa'),
          actorLabel: ACTOR,
        },
        select: { id: true },
      });
    });

    it('is closed to the system role by the grant', async () => {
      await expect(systemPrisma.$executeRawUnsafe(rewrite)).rejects.toThrow(/permission denied/i);
    });

    it('is closed to the table owner by the trigger, which no grant could do', async () => {
      // The owner is bound by no grant, and is the credential a psql session at
      // 2 a.m. runs as — which is exactly the situation this trail exists to
      // record rather than to be edited during.
      await expect(ownerPrisma.$executeRawUnsafe(rewrite)).rejects.toThrow(/append-only/);
    });
  });

  describe('writing a value', () => {
    const key = `${PREFIX}write`;

    it('records no predecessor on the first write', async () => {
      await repository.set({
        key,
        valueEncrypted: payload(key),
        fingerprint: fingerprint('1111'),
        actorLabel: ACTOR,
      });

      const [latest] = await repository.listChanges(key, 10);

      expect(latest).toMatchObject({
        action: 'set',
        previousFingerprint: null,
        newFingerprint: fingerprint('1111'),
        actorLabel: ACTOR,
      });
    });

    it('records the fingerprint it replaced, read inside the same transaction', async () => {
      // From the row rather than from the snapshot, which may be up to one
      // refresh interval stale — a history row claiming the wrong predecessor is
      // worse than no history row at all.
      await repository.set({
        key,
        valueEncrypted: payload(key),
        fingerprint: fingerprint('2222'),
        actorLabel: ACTOR,
      });

      const [latest] = await repository.listChanges(key, 10);

      expect(latest).toMatchObject({
        previousFingerprint: fingerprint('1111'),
        newFingerprint: fingerprint('2222'),
      });
    });

    it('upserts on the key, so a repeat write is an update rather than a duplicate', async () => {
      const rows = await systemPrisma.platformSetting.findMany({ where: { key } });

      expect(rows).toHaveLength(1);
    });

    it('refuses a second row for the same key at the database level', async () => {
      await expect(
        systemPrisma.platformSetting.create({
          data: {
            id: randomUUID(),
            key,
            valueEncrypted: payload(key),
            fingerprint: fingerprint('3333'),
            updatedByLabel: ACTOR,
          },
          select: { id: true },
        }),
      ).rejects.toThrow();
    });
  });

  describe('reverting to the environment', () => {
    const key = `${PREFIX}revert`;

    it('takes the row and leaves the trail', async () => {
      await repository.set({
        key,
        valueEncrypted: payload(key),
        fingerprint: fingerprint('4444'),
        actorLabel: ACTOR,
      });

      await expect(repository.clear(key, ACTOR)).resolves.toBe(true);

      expect(await systemPrisma.platformSetting.findUnique({ where: { key } })).toBeNull();

      const [latest] = await repository.listChanges(key, 10);

      // The history has no foreign key to the setting precisely so it can
      // survive this delete.
      expect(latest).toMatchObject({
        action: 'cleared',
        previousFingerprint: fingerprint('4444'),
        newFingerprint: null,
      });
    });

    it('is a no-op on a key with no row, and writes no history for it', async () => {
      const before = await repository.listChanges(key, 10);

      await expect(repository.clear(key, ACTOR)).resolves.toBe(false);

      expect(await repository.listChanges(key, 10)).toHaveLength(before.length);
    });
  });

  describe('reading the history', () => {
    it('returns the newest entries first', async () => {
      const key = `${PREFIX}write`;
      const changes = await repository.listChanges(key, 10);

      expect(changes.length).toBeGreaterThan(1);

      for (let i = 1; i < changes.length; i += 1) {
        const newer = changes[i - 1];
        const older = changes[i];

        if (newer === undefined || older === undefined) {
          throw new Error('unreachable: the length assertion above would have failed first');
        }

        expect(newer.createdAt.getTime()).toBeGreaterThanOrEqual(older.createdAt.getTime());
      }
    });

    it('never returns a value, in any column', async () => {
      const changes = await repository.listChanges(`${PREFIX}write`, 10);

      expect(JSON.stringify(changes)).not.toContain('ciphertext');
    });
  });
});

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required for this suite. Run \`pnpm db:up && pnpm db:migrate:deploy && ` +
        '`pnpm db:roles && pnpm db:roles:login` first.',
    );
  }

  return value;
}
