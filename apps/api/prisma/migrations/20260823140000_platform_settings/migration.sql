-- Database-backed platform settings (TAR-816, against TAR-811's contract).
--
-- `META_APP_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and
-- `META_EMBEDDED_SIGNUP_CONFIG_ID` are boot-time environment variables today,
-- which means changing one is a redeploy of the platform. These two tables are
-- where an operator-managed override lives instead, with the environment kept as
-- the fallback.
--
-- ---------------------------------------------------------------------------
-- The shape, and the four decisions inside it
-- ---------------------------------------------------------------------------
--
--   1. **Database overrides environment, never the reverse.** Absence of a row
--      *is* the unset state, so an environment that never opens the admin
--      console behaves byte-identically to how it did before this migration.
--      Nothing is backfilled — see the note at the bottom.
--
--   2. **Every value is encrypted, including the public ones.** One column and
--      one code path, so there is no clear column a secret can be written into
--      by mistake. The Meta app id is not a secret and is encrypted anyway; that
--      costs one AES call per snapshot refresh, not per read.
--
--   3. **Sensitivity is not a column.** Which keys exist, which of them are
--      secret and what a write must validate against all live in
--      `platform-settings.registry.ts`. A row whose `key` is not in that
--      registry is ignored on load — which is what makes the allowlist closed,
--      and what stops a rogue row introducing a managed key.
--
--   4. **History stores fingerprints, never values.** `platform_setting_changes`
--      records that a key changed, from which fingerprint to which, and by whom.
--      It does not retain the old secret, so each secret exists in exactly one
--      row in this database.
--
-- ---------------------------------------------------------------------------
-- Grants — required, and easy to miss
-- ---------------------------------------------------------------------------
--
-- Neither table carries `tenant_id`, so neither can carry a `tenant_isolation`
-- policy: there is nothing for one to compare against. On both, as on
-- `webhook_events`, `tenant_signups` and `webhook_event_replays`, **the grant is
-- the enforcement** — `whatsappcrm_app` is granted nothing at all.
-- `app-roles.sql` is updated in the same change and **must be re-run after this
-- migration**, or `verify-tenant-isolation.sql` fails on it. A new table has no
-- grants and no policy until it does.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Two empty tables, one enum, one unique index and
--                one composite index. Nothing existing is read or rewritten.
--   Locks        ACCESS EXCLUSIVE on the new tables, which no session can be
--                holding. Nothing existing is altered, so no lock is taken on a
--                table that is being read.
--   Blocking     Nil.
--   Data loss    None. Purely additive.
--   Rollback     `down.sql` beside this file. There is nothing to preserve: an
--                empty `platform_settings` means every key resolves from the
--                environment, which is the pre-migration behaviour exactly.
--
-- Additive and idempotent: every statement is guarded, so applying this to a
-- fresh database, to one at the previous version, or twice in a row all succeed.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The change action
-- ---------------------------------------------------------------------------
--
-- `set` covers the first write of a key and every later one — `previous_fingerprint`
-- is what distinguishes them, and a separate `created` value would say the same
-- thing twice. `cleared` is the delete that reverts a key to its environment
-- fallback.
--
-- `CREATE TYPE` has no `IF NOT EXISTS` form, so it is guarded on the catalog.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'platform_setting_change_action' AND n.nspname = 'public'
    ) THEN
        CREATE TYPE "public"."platform_setting_change_action" AS ENUM ('set', 'cleared');
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. The current value, one row per managed key
-- ---------------------------------------------------------------------------
--
-- `key` is the natural key and the only access path; the uuid primary key exists
-- for convention with every other model. There is no `is_secret`, no
-- `visibility` and no role column — see decision 3 above.
--
-- `value_encrypted` is never null. "No value" is the absence of a row, not an
-- empty string, so there is exactly one representation of unset and no code path
-- that has to treat two of them alike.

CREATE TABLE IF NOT EXISTS "public"."platform_settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value_encrypted" TEXT NOT NULL,
    "fingerprint" CHAR(8) NOT NULL,
    "updated_by_label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "public"."platform_settings" IS
    'TAR-816. Operator-managed overrides for platform-wide configuration, one row per key. '
    'No tenant_id and no RLS policy: these are the platform''s own credentials, not any '
    'tenant''s. Reachable through SystemPrisma alone — the app role holds no grant, which is '
    'what replaces the policy. Absence of a row means the key resolves from its environment '
    'variable.';

COMMENT ON COLUMN "public"."platform_settings"."key" IS
    'The registry key, e.g. whatsapp.app_secret. A row whose key is absent from '
    'platform-settings.registry.ts is ignored on load and logged at warn — that is what '
    'enforces the allowlist, and it is why this column has no CHECK constraint listing the '
    'keys: adding one is a code change, not a migration.';

COMMENT ON COLUMN "public"."platform_settings"."value_encrypted" IS
    'AES-256-GCM, payload format v1.<iv>.<tag>.<ct>, AAD platform_setting:<key>. Every value '
    'is encrypted including the non-secret ones, so there is no clear column a secret could be '
    'written into by mistake.';

COMMENT ON COLUMN "public"."platform_settings"."fingerprint" IS
    'First 8 hex characters of SHA-256 of the plaintext. Lets the console show that two '
    'environments hold the same secret without decrypting either. Safe to publish only because '
    'every key carries a write-time length floor in the registry.';

COMMENT ON COLUMN "public"."platform_settings"."updated_by_label" IS
    'The label half of the PLATFORM_ADMIN_TOKEN entry that authenticated the write, never the '
    'secret half. Same value audit_logs.actor_label carries for an operator action (TAR-166).';

CREATE UNIQUE INDEX IF NOT EXISTS "platform_settings_key_key"
    ON "public"."platform_settings"("key");

-- ---------------------------------------------------------------------------
-- 3. The history
-- ---------------------------------------------------------------------------
--
-- `key` is deliberately not a foreign key to `platform_settings.key`: the whole
-- point of a `cleared` row is that the setting it names has just been deleted,
-- and a reference would either block that delete or cascade the trail away with
-- it.

CREATE TABLE IF NOT EXISTS "public"."platform_setting_changes" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "action" "public"."platform_setting_change_action" NOT NULL,
    "previous_fingerprint" CHAR(8),
    "new_fingerprint" CHAR(8),
    "actor_label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_setting_changes_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "public"."platform_setting_changes" IS
    'TAR-816. Append-only, one row per platform-setting write or clear. Not an audit_logs row: '
    'audit_logs.tenant_id is NOT NULL with an FK to tenants, and a platform credential belongs '
    'to no tenant. Stores fingerprints and actor labels, never values — so each secret exists '
    'in exactly one row in this database.';

COMMENT ON COLUMN "public"."platform_setting_changes"."previous_fingerprint" IS
    'Null on the first set of a key. Never a value: reverting means re-entering the secret, '
    'which given its origin is the Meta app dashboard is a lookup rather than a loss.';

CREATE INDEX IF NOT EXISTS "platform_setting_changes_key_created_at_idx"
    ON "public"."platform_setting_changes"("key", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- 4. Append-only, enforced against the owner too
-- ---------------------------------------------------------------------------
--
-- The grants in `app-roles.sql` give `whatsappcrm_system` SELECT and INSERT on
-- the history and withhold UPDATE and DELETE, which closes every application
-- path. This closes the other one: the table owner is bound by neither grant,
-- and the owner is the credential a psql session runs as at 2 a.m. — which is
-- exactly the situation this trail exists to record rather than to be edited
-- during.
--
-- The same shape and the same SQLSTATE as `lifecycle_events_append_only` and
-- `webhook_event_replays_append_only`. DELETE is deliberately not blocked: no
-- foreign key reaches these rows, but a retention sweep is a legitimate future
-- operation and blocking it here would be a promise this table should not make
-- on a policy's behalf. UPDATE is the operation that would rewrite history.
--
-- `platform_settings` itself takes no such trigger: it is current state, and
-- every write to it is an UPDATE by design.

CREATE OR REPLACE FUNCTION "public"."platform_setting_changes_forbid_update"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION 'platform_setting_changes is append-only: row % cannot be updated', OLD."id"
        USING ERRCODE = 'TN002',
              HINT = 'A setting change is a fact that happened. Record a correction as a new '
                     'change, not as an edit to the old one.';
END;
$$;

COMMENT ON FUNCTION "public"."platform_setting_changes_forbid_update"() IS
    'TAR-816. Raises TN002 on any UPDATE of platform_setting_changes, including by the table '
    'owner. The grants withhold UPDATE from both application roles; this is the half they '
    'cannot cover.';

DROP TRIGGER IF EXISTS "platform_setting_changes_append_only"
    ON "public"."platform_setting_changes";

CREATE TRIGGER "platform_setting_changes_append_only"
    BEFORE UPDATE ON "public"."platform_setting_changes"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."platform_setting_changes_forbid_update"();

-- ---------------------------------------------------------------------------
-- Backfill strategy: none, deliberately
-- ---------------------------------------------------------------------------
--
-- Copying `WHATSAPP_APP_SECRET` and the three keys beside it out of the
-- environment into encrypted rows on deploy would move every environment onto
-- the database path on day one, with no operator having chosen it — and would
-- put a second copy of a live secret into this database with nobody aware of it.
--
-- The tables start empty. Every key resolves from its environment variable until
-- an operator writes the first row, and `DELETE`ing that row puts it back. The
-- absence of a backfill is what makes this migration a no-op for behaviour.
