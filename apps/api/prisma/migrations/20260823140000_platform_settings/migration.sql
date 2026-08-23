-- Runtime-editable platform configuration, encrypted at rest (TAR-811, TAR-815).
--
-- `META_APP_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and
-- `META_EMBEDDED_SIGNUP_CONFIG_ID` are boot-time environment variables today,
-- validated in `src/config/env.schema.ts` and read per use through
-- `ConfigService`. TAR-800 asks for an operator to be able to change them from
-- the admin console without a redeploy. These two tables are where that change
-- is stored; the architecture that reads them is TAR-811's, and TAR-816 builds
-- it.
--
-- ---------------------------------------------------------------------------
-- The one thing to understand before reading the DDL
-- ---------------------------------------------------------------------------
--
-- **Resolution order is: database row → environment variable → unset.** The
-- environment is the fallback; this table is the override. Chosen over the
-- reverse deliberately, and it is what makes this migration safe to ship on its
-- own: until an operator writes the first row, every key resolves from the
-- environment exactly as it does today, so an empty `platform_settings` *is*
-- the pre-migration behaviour rather than a degraded version of it.
--
-- That is also why there is **no backfill** — see the closing section.
--
-- ---------------------------------------------------------------------------
-- Why two tables rather than columns on one
-- ---------------------------------------------------------------------------
--
-- `platform_settings` is mutable: one row per key, upserted and deleted.
-- `platform_setting_changes` is append-only history. They are separate because
-- the history has to survive a `DELETE` of the setting — a "revert to
-- environment" is precisely the event worth recording, and a child row with a
-- foreign key would be deleted by the very action it documents. Hence `key` as
-- a plain column in the history table, with no FK.
--
-- Neither is an `audit_logs` row. `audit_logs.tenant_id` is NOT NULL with an FK
-- to `tenants`, and a Meta app credential belongs to no tenant. Making that
-- column nullable would touch the `tenant_isolation` policy, the
-- `audit_logs_actor_attribution` CHECK, four indexes and every existing query
-- on the platform's most safety-critical table — for one writer. TAR-811
-- rejected that as disproportionate, on the reasoning that already gave
-- `webhook_event_replays` and `lifecycle_events` tables of their own.
--
-- ---------------------------------------------------------------------------
-- Grants are the enforcement, and they are not in this file
-- ---------------------------------------------------------------------------
--
-- Neither table carries `tenant_id`, so neither can carry a `tenant_isolation`
-- policy and neither is protected by one. What protects them is that
-- `whatsappcrm_app` is granted **nothing at all** on either — the same posture
-- as `webhook_events`, `tenant_signups`, `lifecycle_events` and
-- `webhook_event_replays`.
--
-- ⚠️ **Re-run `pnpm db:roles` after applying this migration.** A new table has
-- no grants until it does, and `app-roles.sql` in this same change carries the
-- branch that keeps it that way for the app role. `verify-tenant-isolation.sql`
-- names both tables in phase 3g, so a forgotten re-run or a lost branch fails
-- by name rather than quietly.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Two empty tables, one enum, two indexes, three
--                CHECK constraints and one trigger function. Nothing existing
--                is read, rewritten or locked.
--   Locks        ACCESS EXCLUSIVE on the two new tables, which no session can
--                be holding. Nothing else is touched — there are no foreign
--                keys out of these tables, so no existing table is locked at
--                all. `lock_timeout` is set below for consistency with the
--                surrounding migrations rather than because there is anything
--                here to queue behind.
--   Blocking     Nil. No existing relation is referenced.
--   Data loss    None. Purely additive.
--   Rollback     `down.sql` beside this file. A clean, complete reversal —
--                read its header for what it destroys.
--
-- Additive and idempotent: every statement is guarded, so applying this to a
-- fresh database, to one at the previous version, or twice in a row all
-- succeed.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The change verb
-- ---------------------------------------------------------------------------
--
-- Two labels, because a managed key has exactly two states an operator can put
-- it in. `cleared` means "revert to environment", not "delete the setting": the
-- key stays managed and keeps resolving, from the environment variable behind
-- it. An enum rather than a boolean so the history reads as what happened.
--
-- `CREATE TYPE` has no `IF NOT EXISTS` form, so the guard is explicit.

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
-- 2. platform_settings — the current value of one managed key
-- ---------------------------------------------------------------------------
--
-- `key` is the natural key; `id` exists because every other model in this schema
-- has one. The unique index on `key` is the only access path, and the table is
-- bounded by the code registry at single-digit rows, so nothing else is
-- warranted — no index on `updated_at`, no index on `updated_by_label`.
--
-- **What is deliberately absent: `is_secret`, `visibility`, and any role or
-- scope column.** Which keys are manageable at all, and whether a key's value
-- may ever leave the API in plaintext, come from the code registry
-- (`src/platform-settings/platform-settings.registry.ts`) and from nowhere
-- else. Sensitivity in a row is sensitivity a row edit can change, and
-- reclassifying `whatsapp.app_secret` as public is not an edit anyone should be
-- one UPDATE away from. A row whose `key` is not in the registry is ignored on
-- load and logged at `warn` — that read, not this DDL, is where the allowlist is
-- enforced.
--
-- TAR-815's acceptance criterion asks whether the access-control model needs
-- per-key visibility metadata here. It does not, and not because it was skipped:
-- TAR-811 settled the question by removing it. No endpoint returns a `secret`
-- plaintext to anybody, there is no reveal action and no role that unlocks one,
-- so there is no read-visibility distinction left for a column to express.

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
    'TAR-811. One row per managed platform configuration key, holding a runtime override for '
    'a boot-time environment variable. Resolution order is row -> environment -> unset, so an '
    'empty table is the pre-migration behaviour and not a degraded one. No tenant_id and no '
    'RLS policy; reachable through SystemPrisma alone, because the app role holds no grant. '
    'Which keys are manageable, and which are secret, live in the code registry and never in '
    'a column here.';

COMMENT ON COLUMN "public"."platform_settings"."key" IS
    'The registry key, e.g. whatsapp.app_secret. The natural key — the uuid is convention. '
    'Never renamed: a rename orphans the row, because the registry looks the value up by this '
    'string. A key not in the registry is ignored on load and logged at warn.';

COMMENT ON COLUMN "public"."platform_settings"."value_encrypted" IS
    'v1.<iv>.<tag>.<ct>, base64url, AES-256-GCM under SECRETS_ENCRYPTION_KEY, with '
    'platform_setting:<key> as AAD — byte-identical to the format WhatsAppCredentialCipher '
    'already writes. EVERY value is encrypted, including the non-secret ones: one column and '
    'one code path means there is no clear column a secret can be written into by mistake. '
    'Never null; "no value" is the absence of a row.';

COMMENT ON COLUMN "public"."platform_settings"."fingerprint" IS
    'First 8 hex characters of SHA-256(plaintext), written with the value. Lets an operator '
    'answer "do staging and production hold the same secret" without decrypting either, and '
    'lets platform_setting_changes reference a value it deliberately does not store. An 8-hex '
    'prefix is offline-guessable for a low-entropy plaintext, which is why the registry puts a '
    'min(32) write floor on both secret keys.';

COMMENT ON COLUMN "public"."platform_settings"."updated_by_label" IS
    'The label half of the PLATFORM_ADMIN_TOKEN entry that authenticated the write, never the '
    'secret half. The same rule audit_logs.actor_label and webhook_event_replays.actor_label '
    'follow.';

-- Prisma emits this name for `@unique` on the model; keeping it is what stops
-- `migrate dev` proposing to drop and recreate the index as drift.
CREATE UNIQUE INDEX IF NOT EXISTS "platform_settings_key_key"
    ON "public"."platform_settings"("key");

-- The AAD binds a payload to `platform_setting:<key>`, so the *shape* of a key
-- is load-bearing rather than cosmetic. This is a shape guard and explicitly
-- **not** the allowlist — the registry is the allowlist, enforced at the read.
-- What it buys is that a typo written straight into the database fails at the
-- INSERT rather than becoming a row that silently never loads.
--
-- Bounded at 64 characters on the same reasoning as `plans_key_format`: a key is
-- an identifier a person types into a code file, not free text.
--
-- Guarded with DROP/ADD rather than `IF NOT EXISTS`, which `ADD CONSTRAINT` has
-- no form of. Both tables are empty at this point, so the validating scan is
-- free.

ALTER TABLE "public"."platform_settings"
    DROP CONSTRAINT IF EXISTS "platform_settings_key_format";

ALTER TABLE "public"."platform_settings"
    ADD CONSTRAINT "platform_settings_key_format" CHECK (
        "key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length("key") <= 64
    );

-- The fingerprint is lowercase hex, exactly 8 characters. `char(8)` pads a short
-- value with spaces rather than rejecting it, and a space is not a hex digit, so
-- this catches the truncation the type does not.

ALTER TABLE "public"."platform_settings"
    DROP CONSTRAINT IF EXISTS "platform_settings_fingerprint_format";

ALTER TABLE "public"."platform_settings"
    ADD CONSTRAINT "platform_settings_fingerprint_format" CHECK (
        "fingerprint" ~ '^[0-9a-f]{8}$'
    );

-- The one constraint here that earns its keep.
--
-- This column is the only place a platform secret is stored, and the failure
-- worth designing against is not a corrupted ciphertext — GCM's auth tag already
-- catches that on the way out — but a **plaintext** value reaching the column: a
-- write path that forgot to encrypt, a hand-run UPDATE during an incident, a
-- restore from a fixture written before the cipher existed. None of those fail
-- on their own; they succeed, and the next read decrypts a value that was never
-- encrypted into an error nobody connects back to the write.
--
-- The envelope shape is the cheapest thing that rejects all of them. A raw Meta
-- app id (`1234567890`), a raw app secret (32 hex characters) and an empty
-- string all fail it.
--
-- Version-agnostic on the tag (`v[0-9]+`) so a future cipher version is not
-- blocked by this file; specific on the three base64url segments, which is the
-- part doing the work. A future envelope with a genuinely different shape
-- changes this constraint in its own migration — a deliberate cost, paid to
-- avoid a column that accepts plaintext.

ALTER TABLE "public"."platform_settings"
    DROP CONSTRAINT IF EXISTS "platform_settings_value_envelope";

ALTER TABLE "public"."platform_settings"
    ADD CONSTRAINT "platform_settings_value_envelope" CHECK (
        "value_encrypted" ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    );

-- ---------------------------------------------------------------------------
-- 3. platform_setting_changes — append-only history
-- ---------------------------------------------------------------------------
--
-- **No previous value is stored, in any form.** Fingerprints only. That
-- forecloses a one-click rollback, and in exchange each secret exists in exactly
-- one row in the database rather than accumulating a tail of superseded copies
-- nobody is tracking. An operator reverting re-enters the value — and since the
-- value's origin is the Meta app dashboard, that is a lookup, not a loss.
--
-- `key` is a plain column, not a foreign key, so the history survives the
-- `DELETE` a `cleared` entry records. That also means a row here can name a key
-- that no longer exists in the registry, which is correct: what an operator did
-- last year is still what they did.

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
    'TAR-811. Append-only, one row per platform setting write or revert. Records that a key '
    'changed, when, and by whom — never what it changed to. Fingerprints only, so the history '
    'is safe to read and each secret exists in exactly one row in the database. No FK to '
    'platform_settings: the history must survive the DELETE a cleared entry documents. '
    'Reachable through SystemPrisma alone, which holds SELECT and INSERT and neither UPDATE '
    'nor DELETE.';

COMMENT ON COLUMN "public"."platform_setting_changes"."previous_fingerprint" IS
    'The fingerprint the key held before this change. Null on the first set for a key, and on '
    'a clear of a key that held no row. Deliberately not constrained against action: a no-op '
    'revert is a real thing an operator can do and is worth recording as one.';

COMMENT ON COLUMN "public"."platform_setting_changes"."new_fingerprint" IS
    'The fingerprint the key holds after this change. Null on cleared, which '
    'platform_setting_changes_fingerprints enforces.';

CREATE INDEX IF NOT EXISTS "platform_setting_changes_key_created_at_idx"
    ON "public"."platform_setting_changes"("key", "created_at" DESC);

-- "What has happened to this key, most recent first" is the only query this
-- table is read by, and the index above keeps it a backwards index scan.

-- Makes the verb and the fingerprints agree with each other, in the shape
-- `audit_logs_actor_attribution` established: a `set` produced a value, a
-- `cleared` did not.
--
-- The `CASE` has no `ELSE` on purpose, and that is the loose end worth naming:
-- an arm that matches nothing evaluates to NULL, and a CHECK treats NULL as
-- satisfied. With exactly two labels in the enum both are covered — but adding a
-- third label silently widens this constraint rather than failing, so the enum's
-- doc comment in `schema.prisma` points back here.

ALTER TABLE "public"."platform_setting_changes"
    DROP CONSTRAINT IF EXISTS "platform_setting_changes_fingerprints";

ALTER TABLE "public"."platform_setting_changes"
    ADD CONSTRAINT "platform_setting_changes_fingerprints" CHECK (
        CASE "action"
            WHEN 'set'     THEN "new_fingerprint" IS NOT NULL
            WHEN 'cleared' THEN "new_fingerprint" IS NULL
        END
    );

-- Same hex guard as on `platform_settings.fingerprint`, on both nullable
-- columns. NULL is permitted; a short or non-hex value is not.

ALTER TABLE "public"."platform_setting_changes"
    DROP CONSTRAINT IF EXISTS "platform_setting_changes_fingerprint_format";

ALTER TABLE "public"."platform_setting_changes"
    ADD CONSTRAINT "platform_setting_changes_fingerprint_format" CHECK (
        ("previous_fingerprint" IS NULL OR "previous_fingerprint" ~ '^[0-9a-f]{8}$')
        AND ("new_fingerprint" IS NULL OR "new_fingerprint" ~ '^[0-9a-f]{8}$')
    );

-- ---------------------------------------------------------------------------
-- 4. Append-only, enforced against the owner too
-- ---------------------------------------------------------------------------
--
-- The grants in `app-roles.sql` give `whatsappcrm_system` SELECT and INSERT and
-- withhold UPDATE and DELETE, which closes every application path. This closes
-- the other one: the table owner is bound by neither grant, and the owner is the
-- credential a psql session runs as at 2 a.m. — which is exactly the situation
-- this trail exists to record rather than to be edited during.
--
-- The same shape and SQLSTATE as `lifecycle_events_append_only` and
-- `webhook_event_replays_append_only`, with no permitted-update exception
-- because there is no column here to settle later.
--
-- DELETE is left to the grants, matching both of those tables. The trigger
-- covers the owner on UPDATE alone, which is the mutation that rewrites history
-- in place; a DELETE at least leaves a gap somebody can notice.

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
    'TAR-811. Raises TN002 on any UPDATE of platform_setting_changes, including by the table '
    'owner. The grants withhold UPDATE from both application roles; this is the half they '
    'cannot cover.';

DROP TRIGGER IF EXISTS "platform_setting_changes_append_only"
    ON "public"."platform_setting_changes";

CREATE TRIGGER "platform_setting_changes_append_only"
    BEFORE UPDATE ON "public"."platform_setting_changes"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."platform_setting_changes_forbid_update"();

-- ---------------------------------------------------------------------------
-- 5. Backfill: none, deliberately
-- ---------------------------------------------------------------------------
--
-- Both tables start empty, and no existing environment value is copied into
-- them — not by this migration, not by a follow-up data migration, and not by
-- the API at boot.
--
-- The obvious alternative is to read `WHATSAPP_APP_SECRET` and friends out of
-- the environment on first boot and write encrypted rows, so the admin console
-- opens with the current values already in it. That is rejected for two
-- reasons, and both matter more than the convenience:
--
--   1. **It moves every environment onto the database path on day one**, with no
--      operator having chosen it. Resolution order is row → environment, so the
--      moment a row exists the environment variable behind it stops having any
--      effect. An operator editing Render's environment group would then be
--      editing a value nothing reads, with nothing to tell them so. Keeping the
--      table empty means the first *write* is what opts an environment in — a
--      deliberate act, by someone who is looking at the screen that explains it.
--
--   2. **It puts a second copy of a live secret in the database**, in an
--      environment where nobody asked for one and nobody knows it is there. The
--      blast radius of a database compromise should not grow as a side effect of
--      a deploy.
--
-- The migration path for an operator who *does* want a value managed is
-- therefore: open the admin console, read the current value from the Meta app
-- dashboard (not from the running environment), and write it. The screen shows
-- `source: environment` before that and `source: database` after, so the state
-- is legible at every point.
--
-- Two consequences worth stating, since they are the price of this choice:
--
--   * Every environment keeps its environment variables set. This feature makes
--     them a fallback; it does not retire them. Removing `WHATSAPP_APP_SECRET`
--     from Render because "it is in the database now" removes the break-glass
--     channel that exists for when the row is wrong.
--   * `WHATSAPP_WEBHOOK_VERIFY_TOKEN` values already in environment groups
--     predate the registry's `min(32)` write floor and may be shorter. They are
--     shown with a fingerprint like any other value, and an 8-hex fingerprint
--     over a low-entropy plaintext is guessable offline. Those environments
--     should rotate the token through the new surface — a runbook note, not a
--     code change, and flagged here so it is not discovered the other way round.
