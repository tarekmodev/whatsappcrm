-- Reverses 20260813150000_assignment_workload_and_routing_state.
--
-- Restores the schema exactly as 20260813140000_routing_rule_schema left it: no
-- routing columns on
-- `tickets`, no cap on `users` or `tenant_settings`, `assignment_state.team_id`
-- back to `NOT NULL` under its two original unique indexes, and neither enum in
-- `pg_type`.
--
-- ---------------------------------------------------------------------------
-- What this destroys, stated plainly
-- ---------------------------------------------------------------------------
--
-- Dropping `tickets.routing_state` and its two companions **throws away which
-- tickets were flagged for supervisor attention, why, and since when.** That is
-- not recoverable from anywhere else on the way back in: re-applying the up
-- migration defaults every ticket to `pending`, and its backfill only recovers
-- the ones that carry an assignment. A ticket that was deferred returns as
-- `pending`, which is the correct-by-luck answer — routing will re-decide it and
-- defer it again — but the supervisor's ageing column restarts from that moment,
-- so a ticket stuck since Tuesday reports as stuck since the rollback.
--
-- `users.max_concurrent_tickets` goes with it, and that one does not come back
-- at all. Every per-agent override a supervisor set is gone, and the re-apply
-- puts everybody back on the tenant default. If any tenant has tuned caps by the
-- time this runs, capture them first:
--
--   SELECT tenant_id, id, max_concurrent_tickets FROM users
--    WHERE max_concurrent_tickets IS NOT NULL;
--
-- `tenant_settings.default_max_concurrent_tickets` is safe to lose only while
-- every tenant is still on 5. Same query shape, same advice.
--
-- Deleting the tenant-pool cursors below is genuinely safe: a cursor is a
-- rotation position, not data, and the next assignment recreates it.
--
-- ---------------------------------------------------------------------------
-- The trap: `SET NOT NULL` cannot succeed while a pool cursor exists
-- ---------------------------------------------------------------------------
--
-- Restoring `assignment_state.team_id` to `NOT NULL` fails outright if any row
-- holds the tenant-pool `NULL`, so those rows are deleted first — and that
-- DELETE has to run with `FORCE ROW LEVEL SECURITY` suspended for the same
-- reason the up migration's backfill does. A migration sets no `app.tenant_id`
-- and FORCE does not exempt the table owner, so the plain DELETE matches zero
-- rows and reports success; the `SET NOT NULL` two statements later is then the
-- thing that fails, naming a column rather than the cause. Locally it appears to
-- work only because the Compose superuser bypasses RLS.
--
-- ---------------------------------------------------------------------------
-- Rolling back is not a neutral act
-- ---------------------------------------------------------------------------
--
-- Between this file and a re-apply, TAR-273's router has no column to write and
-- TAR-274's view has nothing to filter on. Roll the **application** back first
-- and the schema only if the schema is the problem — the order the migrations
-- runbook gives, and the reason the up migration is additive.
--
-- No `pnpm db:roles` re-run is needed in either direction. No table is created
-- or dropped, so no grant and no policy changes, and
-- `verify-tenant-isolation.sql` reads the catalogue rather than a list.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql` (or by `db:rollback`), which is in
-- autocommit. Locks and duration mirror the up migration: ACCESS EXCLUSIVE on
-- the four tables, milliseconds on any current environment.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. `tickets` — the index, the CHECK, then the columns.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "public"."tickets_routing_deferred_idx";

ALTER TABLE "public"."tickets" DROP CONSTRAINT IF EXISTS "tickets_routing_deferred_consistent";

ALTER TABLE "public"."tickets" DROP COLUMN IF EXISTS "routing_deferred_since",
                               DROP COLUMN IF EXISTS "routing_deferred_reason",
                               DROP COLUMN IF EXISTS "routing_state";

-- ---------------------------------------------------------------------------
-- 2. The workload cap.
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."users" DROP CONSTRAINT IF EXISTS "users_max_concurrent_tickets_range";
ALTER TABLE "public"."users" DROP COLUMN IF EXISTS "max_concurrent_tickets";

ALTER TABLE "public"."tenant_settings"
    DROP CONSTRAINT IF EXISTS "tenant_settings_default_max_concurrent_tickets_range";
ALTER TABLE "public"."tenant_settings" DROP COLUMN IF EXISTS "default_max_concurrent_tickets";

-- ---------------------------------------------------------------------------
-- 3. The enums, once nothing refers to them.
-- ---------------------------------------------------------------------------

-- Schema-qualified like every other statement in this file, and here the
-- qualification is doing real work: combined with `IF EXISTS`, a `search_path`
-- resolving somewhere other than `public` makes these two silent no-ops rather
-- than errors, and the next `migrate deploy` then fails on
-- `CREATE TYPE … already exists` with nothing to point at.
DROP TYPE IF EXISTS "public"."ticket_routing_deferred_reason";
DROP TYPE IF EXISTS "public"."ticket_routing_state";

-- ---------------------------------------------------------------------------
-- 4. `assignment_state` back to one cursor per team.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    pool_cursors bigint;
BEGIN
    -- See "The trap" in the header. Without this the DELETE is a no-op under the
    -- deployed role and the `SET NOT NULL` below fails with
    -- `column "team_id" contains null values`.
    EXECUTE 'ALTER TABLE "public"."assignment_state" NO FORCE ROW LEVEL SECURITY';

    DELETE FROM "public"."assignment_state" WHERE "team_id" IS NULL;

    GET DIAGNOSTICS pool_cursors = ROW_COUNT;

    EXECUTE 'ALTER TABLE "public"."assignment_state" FORCE ROW LEVEL SECURITY';

    RAISE NOTICE 'TAR-272 rollback: % tenant-pool rotation cursor(s) deleted', pool_cursors;
END
$$;

DROP INDEX IF EXISTS "public"."assignment_state_tenant_scope_key";

CREATE UNIQUE INDEX "assignment_state_tenant_id_team_id_key"
    ON "public"."assignment_state" ("tenant_id", "team_id");

CREATE UNIQUE INDEX "assignment_state_team_id_key"
    ON "public"."assignment_state" ("team_id");

ALTER TABLE "public"."assignment_state" ALTER COLUMN "team_id" SET NOT NULL;

COMMIT;
