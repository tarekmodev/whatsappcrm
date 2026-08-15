-- Reverses 20260816140000_workflow_rule_schema.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- Restores the shape TAR-47 left on `workflows` and `workflow_runs` — `name` back
-- to `text`, no `position`, no `trigger_type`, no `broken_reason`, no run columns,
-- the ordering index back to `(tenant_id, is_active)` — drops
-- `workflow_references`, `ticket_tags`, the sweep index on `tickets` and the three
-- enums. Statements run in the reverse order of the up migration, so nothing here
-- depends on something this file has already removed.
--
-- ---------------------------------------------------------------------------
-- Safe and lossless on the state the up migration was applied to
-- ---------------------------------------------------------------------------
--
-- That state is `workflows` and `workflow_runs` empty, which the up migration's
-- guard asserts on the way in and which is every environment as of TAR-394 —
-- nothing writes either table until TAR-395. Applied there, this file hands back a
-- structurally identical schema.
--
-- ⚠️ **After TAR-395 ships it destroys three things that cannot be re-derived**,
-- and the third one is worse than a loss:
--
--   * every workflow's trigger, position and broken state, so a supervisor's rules
--     come back unusable — `definition` survives, but the column the evaluator
--     filters on does not;
--   * the automation log: what fired, what it did to which ticket, and why it
--     failed;
--   * **the idempotency ledger.** `dedupe_key` is the reservation, not a record of
--     one (0009, decision 2). Dropping it and re-applying the migration means every
--     open ticket past an elapsed threshold is unclaimed again, so the next sweep
--     re-escalates all of them — a pager storm caused by the rollback, arriving
--     minutes after somebody thought they had made things safer.
--
-- So: apply this only to roll back a deploy whose workers have not run. Past that
-- point, roll the **application** back and leave the schema — every column this
-- file drops is additive and inert to code that predates TAR-395 — and treat any
-- genuine need to remove them as a forward migration with a verified backup and a
-- recorded decision about the runs already recorded.
--
-- `ticket_tags` going takes the tags a workflow applied with it. `TicketResponse`
-- stops carrying them, which is the shape TAR-395's predecessor expects, so nothing
-- breaks — the tags are simply gone, and re-applying does not bring them back.
--
-- ---------------------------------------------------------------------------
-- What it gives up in the meantime, and what it needs afterwards
-- ---------------------------------------------------------------------------
--
-- Between this file and a re-apply there is nothing stopping two workflows in one
-- tenant from being named `Escalate` and `escalate`, and nothing stopping an active
-- workflow from carrying a broken reason. If either accumulates in that window it
-- blocks the way back in — which is correct, and is the up migration's `citext`
-- rebuild and CHECK doing their job.
--
-- **Re-run `pnpm db:roles` after this**, in this direction too: two tables are
-- dropped, so their grants and `system_unrestricted` policies go with them and the
-- catalogue-derived file has one less table to see. `pnpm db:verify:rls` needs the
-- matching revision of `verify-tenant-isolation.sql` — the one that does not name
-- `workflow_references` or `ticket_tags` — so roll that file back with this one
-- rather than running a newer checkout's copy.
--
-- Locks and duration mirror the up migration: ACCESS EXCLUSIVE on `workflows`
-- (`ALTER COLUMN … TYPE` rewrites it), on `workflow_runs`, and on `tickets` for the
-- index drop — which is a catalogue change and instant, unlike the build.
--
-- The explicit transaction is here because, unlike the up migration, this file is
-- applied by hand through `psql`, which is in autocommit. It is the same
-- `BEGIN;`/`COMMIT;` pair ten of the other `down.sql` files carry, so it is the
-- convention rather than a choice made here — and `db:check-migrations` requires
-- exactly this shape: one outermost pair, nothing after the `COMMIT`.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- 5. The elapsed sweep's access path.
DROP INDEX IF EXISTS "public"."tickets_active_created_at_idx";

-- 4. `ticket_tags`. The policy and the grants go with the table.
DROP TABLE IF EXISTS "public"."ticket_tags";

-- 3. `workflow_references`, likewise.
DROP TABLE IF EXISTS "public"."workflow_references";

-- 2. `workflow_runs` back to TAR-47's shape.
DROP INDEX IF EXISTS "public"."workflow_runs_tenant_id_ticket_id_created_at_idx";
DROP INDEX IF EXISTS "public"."workflow_runs_tenant_id_workflow_id_dedupe_key_key";

ALTER TABLE "public"."workflow_runs"
    DROP CONSTRAINT IF EXISTS "workflow_runs_tenant_id_ticket_id_fkey";

ALTER TABLE "public"."workflow_runs"
    DROP CONSTRAINT IF EXISTS "workflow_runs_failure_reason_only_when_failed",
    DROP CONSTRAINT IF EXISTS "workflow_runs_results_is_array";

ALTER TABLE "public"."workflow_runs"
    DROP COLUMN IF EXISTS "failure_reason",
    DROP COLUMN IF EXISTS "results",
    DROP COLUMN IF EXISTS "dedupe_key",
    DROP COLUMN IF EXISTS "workflow_version",
    DROP COLUMN IF EXISTS "ticket_id";

-- 1. `workflows` back to TAR-47's shape.
DROP INDEX IF EXISTS "public"."workflows_tenant_id_is_active_trigger_type_position_id_idx";

CREATE INDEX "workflows_tenant_id_is_active_idx"
    ON "public"."workflows" ("tenant_id", "is_active");

ALTER TABLE "public"."workflows"
    DROP CONSTRAINT IF EXISTS "workflows_broken_is_inactive";

ALTER TABLE "public"."workflows"
    DROP COLUMN IF EXISTS "broken_reason",
    DROP COLUMN IF EXISTS "trigger_type",
    DROP COLUMN IF EXISTS "position";

-- `name` goes back to case-sensitive `text`. The unique index rides along with the
-- type change, as it did on the way out, and comes back NULL-distinct `text` —
-- which is what TAR-47 created.
ALTER TABLE "public"."workflows"
    ALTER COLUMN "name" SET DATA TYPE TEXT USING "name"::TEXT;

-- The enums last: nothing references them once the columns above are gone. Dropped
-- rather than left behind, unlike an `ADD VALUE` that cannot be undone — a type
-- this migration created is a type this migration owns.
DROP TYPE IF EXISTS "workflow_failure_reason";
DROP TYPE IF EXISTS "workflow_broken_reason";
DROP TYPE IF EXISTS "workflow_trigger_type";

COMMIT;
