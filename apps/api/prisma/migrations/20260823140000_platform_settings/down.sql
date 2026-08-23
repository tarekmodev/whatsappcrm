-- Reverses 20260823140000_platform_settings.
--
-- Exact: the forward migration created one enum, two tables, two indexes, five
-- CHECK constraints and one trigger function, and altered nothing that already
-- existed. Dropping the two tables takes their indexes, primary keys, CHECK
-- constraints and the trigger with them, so the four statements below are the
-- whole reversal. Nothing else in the schema references either table — there are
-- no foreign keys in or out — so this cannot fail on a dependency.
--
-- ⚠️ Roll the application back first. At this migration's version
-- `PlatformSettingsService` loads `platform_settings` at `OnModuleInit` and on a
-- 30-second timer, and `/api/v1/admin/platform-settings` writes both tables.
-- Dropping them under a running instance is survivable but noisy: the snapshot
-- load fails, which TAR-811 specifies as "log at error and serve every key from
-- the environment", so the API keeps working on its environment variables while
-- the refresh timer logs a failure every 30 seconds and the admin screen 500s.
-- That is the safe direction, and it is still an alarm nobody needs at the same
-- time as a rollback.
--
-- ⚠️ **This destroys every managed value and the entire change history, and
-- neither is reconstructible from anything else.**
--
--   * `platform_settings` holds the only copy of each override. There is no
--     other row, no previous-value column anywhere, and the plaintext exists
--     nowhere in this system — it came from the Meta app dashboard. After this
--     runs, every key resolves from its environment variable again.
--   * `platform_setting_changes` is the only record of who changed what and
--     when. It stores fingerprints rather than values by design, so even a
--     backup of it would not give the values back — but it is the audit trail,
--     and it is gone.
--
-- **Before running this in any environment where a value has been written:**
-- confirm the environment variable behind every managed key is still set and
-- still correct, because it is what the API falls back to the moment the row
-- disappears. A key whose row was the only place a working value lived will
-- resolve to `unset` and fail closed — every inbound webhook rejected for
-- `whatsapp.app_secret`, the Embedded Signup exchange refusing before it reaches
-- Meta. Export both tables first if the history matters:
--
--     \copy (SELECT * FROM platform_setting_changes ORDER BY created_at) TO 'changes.csv' CSV HEADER
--
-- In an environment that never wrote a setting — which is every environment
-- until an operator opts one in, since this feature ships with no backfill —
-- both tables are empty and this is a pure structural reversal with nothing at
-- risk.
--
-- Statements are in reverse order of the forward file: the tables go before the
-- function they reference, and the enum goes last because a column typed with it
-- still exists until `platform_setting_changes` is dropped.
--
-- Re-runnable: every statement is `IF EXISTS`.

SET LOCAL lock_timeout = '3s';

-- Takes its own trigger, index, primary key and both CHECK constraints with it.
DROP TABLE IF EXISTS "public"."platform_setting_changes";

-- Takes its unique index, primary key and three CHECK constraints with it.
DROP TABLE IF EXISTS "public"."platform_settings";

-- The function is standalone and is not dropped by the table its trigger sat on.
DROP FUNCTION IF EXISTS "public"."platform_setting_changes_forbid_update"();

-- Last: nothing types a column with it any more.
DROP TYPE IF EXISTS "public"."platform_setting_change_action";
