-- Reverses 20260815180000_reporting_attribution_and_anchors.
--
-- Run 20260815180100_reporting_attribution_backfill/down.sql **first** if that
-- migration has been applied. It is not strictly required — dropping a column
-- takes its data with it — but it is the order the rollback runner replays, and
-- keeping to it means the two files read in the direction they were written.
--
-- Leaves `tickets_reporting_metrics_idx` alone. That index is 20260815140000's
-- (TAR-427) and reversing this migration must not take it with it.
--
-- **What it costs, and it is not symmetrical.** Dropping the three indexes costs
-- the response-time, resolution-time and closed-unworked scans their access
-- path: `GET /reports/dashboard` still answers correctly and starts reading the
-- tenant's whole ticket history for those three metrics. Dropping the two
-- columns **loses data** — every attribution recorded since deploy. The backfill
-- in 20260815180100 reconstructs most of it on the way back up, within the
-- limits its header states (a resolution with no `status_changed` event, and
-- 0006 risk 3's second-conversation reply, are gone for good).
--
-- So the honest rollback for a *performance* problem is to drop the indexes only
-- and leave the columns: they are nullable, nothing but `ReportingModule` reads
-- them, and an unread column costs a deploy nothing. The column drops are here
-- because a rollback has to reach the state before this migration, not because
-- they are the first thing to reach for.
--
-- Dropping a column drops the foreign key and any index on it with it, so the
-- two constraints need no statement of their own.
--
-- No `pnpm db:roles` re-run is needed in either direction: a column inherits the
-- table's grants and the table's RLS policy, and neither moves here.
--
-- The explicit transaction is here because, unlike the up migration, this file is
-- applied by hand through `psql`, which is in autocommit.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "public"."tickets_tenant_id_first_response_at_idx";
DROP INDEX IF EXISTS "public"."tickets_tenant_id_resolved_at_idx";
DROP INDEX IF EXISTS "public"."tickets_tenant_id_closed_at_idx";

ALTER TABLE "public"."tickets"
    DROP COLUMN IF EXISTS "first_response_user_id",
    DROP COLUMN IF EXISTS "resolved_by_user_id";

COMMIT;
