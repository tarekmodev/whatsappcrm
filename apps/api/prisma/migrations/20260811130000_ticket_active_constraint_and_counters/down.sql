-- Reverses 20260811130000_ticket_active_constraint_and_counters.
--
-- Restores the schema exactly as 20260811120000 left it: no
-- `tickets_one_active_per_contact`, no `ticket_counters`, and no policy for it
-- in `pg_policies`. `tickets` itself is untouched by both directions — the up
-- migration added no column and this removes none.
--
-- **What this discards, stated plainly.** Dropping `ticket_counters` throws
-- away every tenant's next-number high-water mark. That is not history and no
-- ticket references it, but re-applying the up migration afterwards starts
-- every tenant back at 1 — so the next ticket created collides with an existing
-- one on `UNIQUE (tenant_id, number)` and keeps colliding until the counter
-- catches up. If any tickets exist when this is run, the re-apply needs a
-- backfill in front of it:
--
--   INSERT INTO ticket_counters (tenant_id, next_number)
--   SELECT tenant_id, max(number) + 1 FROM tickets GROUP BY tenant_id;
--
-- **And what it gives up.** Between this file and a re-apply there is nothing
-- stopping two concurrent inbound messages from creating two active tickets for
-- one contact. Rolling back is therefore not a neutral act on a live system:
-- run it, and the invariant TAR-21 depends on is off. If duplicates accumulate
-- in that window they will block the index build on the way back in — which is
-- correct, and is the guard in `migration.sql` doing its job.
--
-- No `pnpm db:roles` re-run is needed after this. Dropping the table drops its
-- grants and its `system_unrestricted` policy with it, and
-- `verify-tenant-isolation.sql` derives its list from the catalog, so it passes
-- again on its own.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit.
--
-- Locks and duration mirror the up migration: ACCESS EXCLUSIVE on `tickets`
-- while the index drops, milliseconds on any current environment.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- The policy goes with the table; dropped explicitly so the intent is visible
-- in the file rather than implied by the DROP TABLE below.
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."ticket_counters";

DROP TABLE IF EXISTS "public"."ticket_counters";

DROP INDEX IF EXISTS "public"."tickets_one_active_per_contact";

COMMIT;
