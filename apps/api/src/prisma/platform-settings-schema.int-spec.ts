import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';

/**
 * `platform_settings` and `platform_setting_changes` — the storage layer for
 * runtime-editable platform configuration (TAR-811, TAR-815).
 *
 * Almost nothing this migration establishes is visible to the rest of the
 * toolchain, which is why it needs a suite of its own:
 *
 *   * **The five CHECK constraints.** Prisma's schema language cannot express a
 *     CHECK and its describer does not report one, so `migrate dev` proposes
 *     neither to create nor to drop them. If one disappeared, every unit test
 *     would still pass. Same arrangement, and the same reasoning, as
 *     `plans_key_format` (TAR-657) and `canned_responses_shortcut_format`
 *     (TAR-475).
 *   * **The grants.** Neither table carries `tenant_id`, so neither carries a
 *     `tenant_isolation` policy and neither is protected by one. What protects
 *     them is that `whatsappcrm_app` is granted nothing — which is a property of
 *     `app-roles.sql` having been re-run, not of the migration having been
 *     applied. `verify-tenant-isolation.sql` names both tables, and this asserts
 *     the same thing from the side the application sees.
 *   * **The append-only trigger**, which binds the table owner and therefore no
 *     grant can be read as a substitute for.
 *
 * The constraint that matters most here is `platform_settings_value_envelope`.
 * This column is the only place a platform secret is stored, and the failure
 * worth designing against is not a corrupted ciphertext — GCM's auth tag already
 * catches that on the way out — but a *plaintext* value reaching the column from
 * a write path that forgot to encrypt. That does not fail on its own; it
 * succeeds, and the next read turns it into a decrypt error nobody connects back
 * to the write.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Fixture rows use a
 * `tar815.` key prefix — which is also a valid registry key shape, deliberately,
 * so the format constraint is not what makes them pass — and are removed before
 * the run as well as after it, so an interrupted run cleans up on the next one.
 * Nothing here touches a row it did not create, and neither table has a row in
 * any environment until an operator writes one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const FIXTURE_PREFIX = 'tar815.';
const SETTING_ID = '81581581-8158-7815-8815-815815815001';

/**
 * A syntactically valid `v1` envelope: version tag plus three base64url
 * segments. Not real ciphertext — nothing here decrypts anything, and the point
 * of the constraint is that the database judges the shape without holding a key.
 */
const VALID_ENVELOPE = 'v1.aXZpdmlpdml2aXY.dGFndGFndGFndGFndGFndGFn.Y2lwaGVydGV4dA';

/** First 8 hex of some SHA-256. The column stores a prefix, never a value. */
const VALID_FINGERPRINT = 'a1b2c3d4';

describe('the platform settings schema', () => {
  let systemPrisma: PrismaClient;
  /**
   * The migration owner — `DATABASE_URL`, the role `prisma migrate deploy`
   * connects as. Present only so the append-only trigger can be tested against
   * the one credential the grants do not bind.
   */
  let ownerPrisma: PrismaClient;

  /** A valid row, so each test varies only the column it is about. */
  function validSetting(
    overrides: Partial<Prisma.PlatformSettingUncheckedCreateInput> = {},
  ): Prisma.PlatformSettingUncheckedCreateInput {
    return {
      id: SETTING_ID,
      key: `${FIXTURE_PREFIX}app_secret`,
      valueEncrypted: VALID_ENVELOPE,
      fingerprint: VALID_FINGERPRINT,
      updatedByLabel: 'tar815-fixture',
      ...overrides,
    };
  }

  function validChange(
    overrides: Partial<Prisma.PlatformSettingChangeUncheckedCreateInput> = {},
  ): Prisma.PlatformSettingChangeUncheckedCreateInput {
    return {
      key: `${FIXTURE_PREFIX}app_secret`,
      action: 'set',
      previousFingerprint: null,
      newFingerprint: VALID_FINGERPRINT,
      actorLabel: 'tar815-fixture',
      ...overrides,
    };
  }

  function checkDefinition(table: string, name: string): Promise<{ definition: string }[]> {
    return systemPrisma.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = ${`public.${table}`}::regclass AND conname = ${name}
    `;
  }

  async function removeFixture(): Promise<void> {
    // The owner, not `systemPrisma`: the history table withholds DELETE from
    // the system role, which is the property this suite asserts below.
    await ownerPrisma.$executeRaw`
      DELETE FROM platform_setting_changes WHERE key LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await ownerPrisma.$executeRaw`
      DELETE FROM platform_settings WHERE key LIKE ${`${FIXTURE_PREFIX}%`}
    `;
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    ownerPrisma = createPrismaClient('system', requireEnv('DATABASE_URL'));

    await removeFixture();
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  });

  beforeEach(async () => {
    await removeFixture();
  });

  describe('the catalog', () => {
    it.each([
      ['platform_settings', 'platform_settings_key_format'],
      ['platform_settings', 'platform_settings_fingerprint_format'],
      ['platform_settings', 'platform_settings_value_envelope'],
      ['platform_setting_changes', 'platform_setting_changes_fingerprints'],
      ['platform_setting_changes', 'platform_setting_changes_fingerprint_format'],
    ])('carries %s.%s', async (table, name) => {
      const [constraint] = await checkDefinition(table, name);

      // Asserting a body rather than only the name: a constraint quietly
      // widened to `CHECK (true)` passes a name-only check and fails every
      // behaviour test below.
      expect(constraint?.definition).toMatch(/CHECK/);
      expect(constraint?.definition).not.toBe('CHECK (true)');
    });

    it('keeps the version tag in the envelope check open-ended', async () => {
      const [constraint] = await checkDefinition(
        'platform_settings',
        'platform_settings_value_envelope',
      );

      // `v[0-9]+` rather than a literal `v1`, so rotating the cipher to a `v2`
      // payload is a code change and not also a migration. The three base64url
      // segments are the part doing the work.
      expect(constraint?.definition).toContain('v[0-9]+');
    });

    it('holds no unique index on the history table, which is append-only by key', async () => {
      // The history is many-rows-per-key by construction. A unique index here
      // would be a misreading of the model that only shows up on the second
      // change to a setting — long after the migration was reviewed.
      const indexes = await systemPrisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'platform_setting_changes'
      `;

      const unique = indexes
        .map(({ indexdef }) => indexdef)
        .filter((indexdef) => indexdef.includes('UNIQUE'));

      // The primary key, and nothing else.
      expect(unique).toHaveLength(1);
      expect(unique[0]).toContain('platform_setting_changes_pkey');
    });
  });

  describe('the stored value', () => {
    it('accepts a well-formed encrypted envelope', async () => {
      await expect(
        systemPrisma.platformSetting.create({ data: validSetting() }),
      ).resolves.toMatchObject({ fingerprint: VALID_FINGERPRINT });
    });

    it.each([
      // The failure this constraint exists for: a write path that forgot to
      // encrypt. A Meta app id is all digits and would otherwise store happily.
      ['a plaintext Meta app id', '1234567890'],
      ['a plaintext app secret', '0123456789abcdef0123456789abcdef'],
      ['an empty string', ''],
      ['an envelope missing its ciphertext segment', 'v1.aXY.dGFn'],
      ['an envelope with no version tag', 'aXY.dGFn.Y3Q'],
      ['base64 with padding, which base64url does not emit', 'v1.aXY=.dGFn.Y3Q'],
    ])('refuses %s', async (_reason, valueEncrypted) => {
      await expect(
        systemPrisma.platformSetting.create({ data: validSetting({ valueEncrypted }) }),
      ).rejects.toThrow(/platform_settings_value_envelope/);
    });

    it('refuses an UPDATE onto a value it would have refused on insert', async () => {
      // A CHECK covers the UPDATE path too, and the write path here is an
      // upsert — so the update branch is the one an operator actually exercises
      // on every key after the first time.
      await systemPrisma.platformSetting.create({ data: validSetting() });

      await expect(
        systemPrisma.platformSetting.update({
          where: { id: SETTING_ID },
          data: { valueEncrypted: 'plaintext-after-all' },
        }),
      ).rejects.toThrow(/platform_settings_value_envelope/);
    });
  });

  describe('the key', () => {
    it.each([
      ['a dotted registry key', 'whatsapp.app_secret'],
      ['more than one segment separator', 'polar.webhook.secret'],
      ['underscores inside a segment', 'meta.embedded_signup_config_id'],
    ])('accepts %s', async (_reason, key) => {
      await expect(
        systemPrisma.platformSetting.create({ data: validSetting({ key }) }),
      ).resolves.toMatchObject({ key });

      await removeFixture();
      await ownerPrisma.$executeRaw`DELETE FROM platform_settings WHERE key = ${key}`;
    });

    it.each([
      // The likeliest mistake: writing the environment variable name.
      ['the environment variable name', 'WHATSAPP_APP_SECRET'],
      ['no dotted namespace at all', 'app_secret'],
      ['a leading dot', '.app_secret'],
      ['a trailing dot', 'whatsapp.'],
      ['a hyphen', 'whatsapp.app-secret'],
      ['a space', 'whatsapp. app_secret'],
      ['nothing at all', ''],
    ])('refuses a key that is %s', async (_reason, key) => {
      await expect(
        systemPrisma.platformSetting.create({ data: validSetting({ key }) }),
      ).rejects.toThrow(/platform_settings_key_format/);
    });

    it('holds at most one row per key', async () => {
      await systemPrisma.platformSetting.create({ data: validSetting() });

      await expect(
        systemPrisma.platformSetting.create({
          data: validSetting({ id: '81581581-8158-7815-8815-815815815002' }),
        }),
      ).rejects.toThrow(/platform_settings_key_key|Unique constraint/);
    });
  });

  describe('the fingerprint', () => {
    it.each([
      // `char(8)` pads a short value with spaces rather than rejecting it, and a
      // space is not a hex digit — so the constraint catches the truncation the
      // type silently accepts.
      ['shorter than eight characters', 'abc'],
      ['uppercase hex', 'A1B2C3D4'],
      ['not hex at all', 'zzzzzzzz'],
    ])('refuses one that is %s', async (_reason, fingerprint) => {
      await expect(
        systemPrisma.platformSetting.create({ data: validSetting({ fingerprint }) }),
      ).rejects.toThrow(/platform_settings_fingerprint_format/);
    });
  });

  describe('the change history', () => {
    it('records a set with the fingerprint it produced', async () => {
      await expect(
        systemPrisma.platformSettingChange.create({ data: validChange() }),
      ).resolves.toMatchObject({ action: 'set', newFingerprint: VALID_FINGERPRINT });
    });

    it('records a clear with no new fingerprint', async () => {
      await expect(
        systemPrisma.platformSettingChange.create({
          data: validChange({
            action: 'cleared',
            previousFingerprint: VALID_FINGERPRINT,
            newFingerprint: null,
          }),
        }),
      ).resolves.toMatchObject({ action: 'cleared', newFingerprint: null });
    });

    it('refuses a set that produced no fingerprint', async () => {
      await expect(
        systemPrisma.platformSettingChange.create({
          data: validChange({ newFingerprint: null }),
        }),
      ).rejects.toThrow(/platform_setting_changes_fingerprints/);
    });

    it('refuses a clear that somehow produced one', async () => {
      // A `cleared` entry carrying a new fingerprint means the code that wrote
      // it did not actually delete the row — the history and the table would
      // disagree, and the history is what an incident is read from.
      await expect(
        systemPrisma.platformSettingChange.create({
          data: validChange({ action: 'cleared', newFingerprint: VALID_FINGERPRINT }),
        }),
      ).rejects.toThrow(/platform_setting_changes_fingerprints/);
    });

    it('stores no value, in any column', async () => {
      // The strongest statement this suite can make about the design: read the
      // catalog rather than the rows, so a column added later that could hold a
      // plaintext fails here on the day it is added.
      const columns = await systemPrisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'platform_setting_changes'
        ORDER BY column_name
      `;

      expect(columns.map(({ column_name }) => column_name)).toEqual([
        'action',
        'actor_label',
        'created_at',
        'id',
        'key',
        'new_fingerprint',
        'previous_fingerprint',
      ]);
    });

    it('survives the deletion of the setting it describes', async () => {
      // No foreign key, deliberately: a `cleared` entry documents exactly the
      // DELETE that a child row would have been removed by.
      await systemPrisma.platformSetting.create({ data: validSetting() });
      await systemPrisma.platformSettingChange.create({ data: validChange() });

      await systemPrisma.platformSetting.delete({ where: { id: SETTING_ID } });

      await expect(
        systemPrisma.platformSettingChange.count({
          where: { key: `${FIXTURE_PREFIX}app_secret` },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('the change history is append-only', () => {
    it('refuses an UPDATE from the widest credential the application holds', async () => {
      await systemPrisma.platformSettingChange.create({ data: validChange() });

      // `whatsappcrm_system` is unrestricted almost everywhere else in the
      // schema. Here it is stopped by the grant, before the trigger is reached.
      await expect(
        systemPrisma.$executeRaw`
          UPDATE platform_setting_changes SET actor_label = 'tampered'
          WHERE key = ${`${FIXTURE_PREFIX}app_secret`}
        `,
      ).rejects.toThrow(/permission denied/);
    });

    it('refuses an UPDATE from the owner, which no grant constrains', async () => {
      await systemPrisma.platformSettingChange.create({ data: validChange() });

      // The 2 a.m. psql session the trigger exists for. On a surface where every
      // operator token is authorised for everything, this trail is the only
      // thing that distinguishes two operators afterwards.
      await expect(
        ownerPrisma.$executeRaw`
          UPDATE platform_setting_changes SET actor_label = 'tampered'
          WHERE key = ${`${FIXTURE_PREFIX}app_secret`}
        `,
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('the grants, which are what replaces a policy here', () => {
    it('carries no RLS policy on either table, because neither has a tenant', async () => {
      const policies = await systemPrisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('platform_settings', 'platform_setting_changes')
      `;

      expect(policies).toEqual([]);
    });

    it('grants the app role nothing at all on either table', async () => {
      // The whole of the protection. `platform_settings` holds the Meta app
      // secret encrypted at rest, so a grant here would put every tenant's
      // connection one SELECT away from a platform credential's ciphertext.
      const grants = only(
        await systemPrisma.$queryRaw<
          {
            settings_select: boolean;
            settings_insert: boolean;
            changes_select: boolean;
            changes_insert: boolean;
          }[]
        >`
          SELECT
            has_table_privilege('whatsappcrm_app', 'platform_settings', 'SELECT') AS settings_select,
            has_table_privilege('whatsappcrm_app', 'platform_settings', 'INSERT') AS settings_insert,
            has_table_privilege('whatsappcrm_app', 'platform_setting_changes', 'SELECT') AS changes_select,
            has_table_privilege('whatsappcrm_app', 'platform_setting_changes', 'INSERT') AS changes_insert
        `,
      );

      expect(grants).toEqual({
        settings_select: false,
        settings_insert: false,
        changes_select: false,
        changes_insert: false,
      });
    });

    it('leaves platform_settings fully writable by the system role, and its history not', async () => {
      const grants = only(
        await systemPrisma.$queryRaw<
          {
            settings_update: boolean;
            settings_delete: boolean;
            changes_select: boolean;
            changes_insert: boolean;
            changes_update: boolean;
            changes_delete: boolean;
          }[]
        >`
          SELECT
            has_table_privilege('whatsappcrm_system', 'platform_settings', 'UPDATE') AS settings_update,
            has_table_privilege('whatsappcrm_system', 'platform_settings', 'DELETE') AS settings_delete,
            has_table_privilege('whatsappcrm_system', 'platform_setting_changes', 'SELECT') AS changes_select,
            has_table_privilege('whatsappcrm_system', 'platform_setting_changes', 'INSERT') AS changes_insert,
            has_table_privilege('whatsappcrm_system', 'platform_setting_changes', 'UPDATE') AS changes_update,
            has_table_privilege('whatsappcrm_system', 'platform_setting_changes', 'DELETE') AS changes_delete
        `,
      );

      // The asymmetry is the design, not an oversight: a setting is mutable
      // because an operator's write is an upsert and "revert to environment" is
      // a DELETE. Only the history is append-only.
      expect(grants).toEqual({
        settings_update: true,
        settings_delete: true,
        changes_select: true,
        changes_insert: true,
        changes_update: false,
        changes_delete: false,
      });
    });
  });
});

function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);

  const [row] = rows;

  if (row === undefined) {
    throw new Error('unreachable: the length assertion above would have failed first');
  }

  return row;
}

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
