-- Reverses 20260816170000_lifecycle_reminder_stamps.
--
-- Both columns are additive with no default and no constraint, so the reversal
-- is exact: nothing was renamed or retyped, and no row's data is reinterpreted
-- on the way back.
--
-- ⚠️ Roll the application back first. At this migration's version
-- `TenantLifecycleSweeper` reads and writes both columns, so dropping them under
-- a running instance turns every sweep into a failure — and a failing sweep is
-- silent, because its only symptom is that timers stop firing.
--
-- The one documented loss: the record of which tenants have already had a
-- `trial_ending` or `deletion_reminder` email for the timer currently running.
-- Re-applying this migration starts both stamps at NULL again, so those tenants
-- receive one duplicate reminder on the next sweep. That is the safe direction —
-- the alternative failure is a tenant purged without ever being warned.

ALTER TABLE "public"."tenants"
    DROP COLUMN IF EXISTS "deletion_reminder_notified_at";

ALTER TABLE "public"."tenants"
    DROP COLUMN IF EXISTS "trial_ending_notified_at";
