-- The two columns the lifecycle sweep needs to send a reminder **once**
-- (TAR-404, ADR 0009 decision 7).
--
-- ---------------------------------------------------------------------------
-- Why this exists
-- ---------------------------------------------------------------------------
--
-- Nine of 0009's eleven notifications hang off a `lifecycle_events` row, and
-- that row carries `notified_at`, so "has this been sent" already has an answer
-- and a backstop. Two of them do not:
--
--   trial_ending       fires at `trial_ends_at` − `trialEndingReminderDays`
--   deletion_reminder  fires at `purge_at`      − `deletionReminderDays`
--
-- 0009 calls both "timer, not a transition", and that is exactly the problem
-- they create. Nothing changes state when they fire, so there is no
-- `lifecycle_events` row to stamp — `lifecycle_events_transition_changes_state`
-- refuses a row whose two states are equal, and it is right to. The sweep runs
-- every five minutes over a window measured in days, so without somewhere to
-- record the send, a tenant three days from the end of its trial is emailed
-- roughly 864 times.
--
-- A BullMQ job id would deduplicate while the job is retained and not after, and
-- 0009's own rule for this shape is the one being followed here: **the row is
-- the truth, the queue is an accelerator.** So the truth goes in a column.
--
-- ---------------------------------------------------------------------------
-- Why on `tenants` rather than a table of their own
-- ---------------------------------------------------------------------------
--
-- Each is one nullable instant per tenant, read by the same sweep pass that has
-- the `tenants` row in front of it already and written in the same UPDATE. A
-- `lifecycle_reminders` table would be one row per tenant, joined on every
-- sweep, to hold two timestamps that have exactly the lifetime of the tenant
-- row they hang off.
--
-- They are **forward-looking state, not history**, which is what makes clearing
-- them correct rather than lossy: `TenantLifecycleService` clears
-- `trial_ending_notified_at` on any edge that leaves `trialing` and
-- `deletion_reminder_notified_at` on any edge that leaves `suspended`, in the
-- same statement that clears `trial_ends_at` and `purge_at`. A tenant that is
-- reactivated and later suspended again gets its reminder again, because the
-- timer it belongs to is a new one.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Both take PostgreSQL 11+'s non-rewriting
--                `ADD COLUMN` path: nullable, no default, so it is a catalog
--                update regardless of row count.
--   Locks        ACCESS EXCLUSIVE on `tenants` for the two ALTERs, held to the
--                end of the transaction Prisma wraps the file in. Capped at
--                three seconds by `lock_timeout`.
--   Blocking     A tenant-facing request touching `tenants` — which is every
--                request, through the gate — queues behind it for those
--                milliseconds. `lock_timeout` makes a blocked migration abort
--                rather than stack requests behind it.
--   Rewrite      None.
--   Backfill     None, and NULL is the correct starting value: it means "no
--                reminder has been sent for the timer currently running". A
--                tenant already inside its reminder window when this applies
--                gets one email on the next sweep, which is the outcome that
--                was intended for it anyway.
--   Idempotent   `IF NOT EXISTS` on both, so re-running the runner over a
--                database that is already part-migrated succeeds quietly.
--   Rollback     `down.sql` beside this file. No data loss beyond the two
--                stamps, named there.
--
-- No index. The sweep finds these rows through `tenants_grace_due` and
-- `tenants_purge_due` — and, for the trial reminder, through the `status`
-- predicate plus `trial_ends_at` — and reads these columns off the row it
-- already has. An index on a column that is NULL for most tenants at any instant
-- would cost a write per reminder and never be chosen.

SET LOCAL lock_timeout = '3s';

ALTER TABLE "public"."tenants"
    ADD COLUMN IF NOT EXISTS "trial_ending_notified_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN "public"."tenants"."trial_ending_notified_at" IS
    'TAR-404, ADR 0009 decision 7. When the trial_ending reminder was sent for the trial currently '
    'running. NULL means one is owed once trial_ends_at is within trialEndingReminderDays. Cleared '
    'by any transition that leaves trialing, so a new trial re-arms the reminder.';

ALTER TABLE "public"."tenants"
    ADD COLUMN IF NOT EXISTS "deletion_reminder_notified_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN "public"."tenants"."deletion_reminder_notified_at" IS
    'TAR-404, ADR 0009 decision 7. When the deletion_reminder was sent for the retention window '
    'currently running. NULL means one is owed once purge_at is within deletionReminderDays. '
    'Cleared by any transition that leaves suspended, so a re-suspension re-arms the reminder.';
