-- Reverses 20260813130000_sla_pause_accounting_and_alerts.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- What this costs, and when it is safe
-- ---------------------------------------------------------------------------
--
-- Safe and lossless on the state this migration was applied to: `sla_timers` and
-- `sla_alerts` both empty, and no tenant having edited the policy row the
-- backfill wrote. That is every environment as of TAR-270 — nothing reads or
-- writes any of it until TAR-280 ships.
--
-- **After TAR-280 it destroys the supervisor's record of every breach.**
-- `sla_alerts` is the delivery record, the read model and the idempotency ledger
-- all at once, so dropping it does not merely lose a notification: re-applying
-- the migration afterwards leaves timers already flipped to `breached` with no
-- alert row and no way to re-derive one, because the conditional
-- `UPDATE ... WHERE state = 'running'` that would have raised it can never match
-- again (0006, decision 3). `breached_at` goes with the column drop for the same
-- reason.
--
-- So: apply this only to roll back a deploy that has not yet run a sweep. Past
-- that point the forward fix is a new migration.
--
-- ---------------------------------------------------------------------------
-- The backfilled `sla_policies` rows are deliberately left in place
-- ---------------------------------------------------------------------------
--
-- Deleting them would be the symmetric thing to do and it is the wrong thing to
-- do, for two reasons:
--
--   * A tenant may have edited its window, or turned SLA off with
--     `is_active = false`. Neither is distinguishable from an untouched
--     backfilled row by anything this script can read, and destroying a tenant's
--     own configuration to undo a schema change is not a rollback.
--   * The rows are inert to code that predates TAR-270. Nothing read
--     `sla_policies` before this story, so leaving them changes no behaviour on
--     the version being rolled back to — and re-applying the migration finds
--     them and skips, because the backfill is guarded by `NOT EXISTS`.
--
-- If they genuinely have to go, that is a separate, explicit statement run with
-- a named tenant list and a verified backup. It is not a rollback step.
--
-- Order matters: the foreign keys out of `sla_alerts` go with the table, and the
-- table goes before the `sla_timers` unique index it references.

SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "public"."sla_alerts";

DROP INDEX IF EXISTS "public"."sla_timers_tenant_id_id_key";
DROP INDEX IF EXISTS "public"."sla_timers_state_due_at_idx";

ALTER TABLE "public"."sla_timers"
    DROP COLUMN IF EXISTS "breached_at",
    DROP COLUMN IF EXISTS "paused_at",
    DROP COLUMN IF EXISTS "paused_ms";
