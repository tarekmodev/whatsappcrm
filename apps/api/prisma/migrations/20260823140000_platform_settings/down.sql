-- Reverses 20260823140000_platform_settings.
--
-- Exact: the forward migration created one enum, two tables, two indexes and one
-- trigger function, and altered nothing that already existed. Dropping the
-- tables takes their indexes, primary keys and trigger with them, so the four
-- statements below are the whole reversal.
--
-- ⚠️ Roll the application back first. At this migration's version
-- `PlatformSettingsService` reads `platform_settings` at boot and on a 30-second
-- timer; dropping the table under a running instance turns every refresh into a
-- logged error. It fails in the safe direction — the snapshot degrades to the
-- environment fallback, which is the behaviour this whole feature preserves —
-- but the admin surface answers 500 on every write until the rollback lands.
--
-- ⚠️ **Every managed override is destroyed, and the values are not recoverable
-- from this database.** The rows hold the only copy of anything an operator
-- entered through the admin console that is not also in the environment, and the
-- history stores fingerprints rather than values by design. Any key whose
-- effective value came from a row rather than from the environment reverts to
-- whatever the environment holds — which for a rotated secret is the superseded
-- one. Before running this: read `GET /api/v1/admin/platform-settings`, note
-- every key reporting `source: "database"`, and make sure the environment group
-- carries the value you intend those keys to fall back to.
--
-- Statements are in reverse order of the forward file, so the function is gone
-- only after the trigger that references it, and the enum only after the column
-- that uses it.

SET LOCAL lock_timeout = '3s';

-- The table takes its own trigger with it; the function is standalone and is not
-- dropped by the table.
DROP TABLE IF EXISTS "public"."platform_setting_changes";

DROP FUNCTION IF EXISTS "public"."platform_setting_changes_forbid_update"();

DROP TABLE IF EXISTS "public"."platform_settings";

DROP TYPE IF EXISTS "public"."platform_setting_change_action";
