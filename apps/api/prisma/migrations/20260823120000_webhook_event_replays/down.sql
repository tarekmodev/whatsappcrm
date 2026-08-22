-- Reverses 20260823120000_webhook_event_replays.
--
-- Exact: the forward migration created one table, one index, one foreign key and
-- one trigger function, and nothing existing was altered. Dropping the table
-- takes its index, its primary key and its foreign key with it, so the two
-- statements below are the whole reversal.
--
-- ⚠️ Roll the application back first. At this migration's version
-- `POST /api/v1/admin/webhook-events/{id}/replay` writes a row here inside the
-- same transaction as the status reset, so dropping the table under a running
-- instance turns every replay into a 500 — and, because the write is one
-- transaction, into a replay that also does not happen. That fails in the safe
-- direction, but it is still an operator surface that reports a fault when it is
-- asked to recover a message.
--
-- ⚠️ **The trail is destroyed, and it is not reconstructible.** These rows are
-- the only record of who replayed which event: `webhook_events` keeps no
-- replayed-by column, and the reset clears the `last_error` that said what was
-- being recovered. Export the table before running this if any replay has
-- happened in this environment.
--
-- Statements are in reverse order of the forward file, so the function is gone
-- only after the trigger that references it.

SET LOCAL lock_timeout = '3s';

-- The table takes its own trigger with it; the function is standalone and is not
-- dropped by the table.
DROP TABLE IF EXISTS "public"."webhook_event_replays";

DROP FUNCTION IF EXISTS "public"."webhook_event_replays_forbid_update"();
