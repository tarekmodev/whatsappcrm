-- Reverses 20260813140000_routing_rule_schema.
--
-- Restores the shape `20260811170000` left on `assignment_rules`: `name` back
-- to `text` with no unique index, no `assignment_rules_active_has_one_target`,
-- `action JSONB NOT NULL` back, and the ordering index back to its three-column
-- form. Statements are in the reverse order of the up migration, so nothing
-- here depends on something this file has already removed.
--
-- **What this cannot restore, stated plainly.** `action` comes back as a
-- column and comes back empty. `DROP COLUMN` destroyed its contents and no
-- down migration can undo that — this one writes `{}` into every existing row,
-- because the column is `NOT NULL` and Postgres has to put something there. It
-- is acceptable only because the column was unread and unwritten in every
-- environment the up migration can reach; if that ever stops being true, the
-- drop belongs in its own separately deployable migration behind a copy of the
-- data, not in a better `down.sql`.
--
-- The `DEFAULT '{}'` is added and immediately dropped on purpose: the default
-- is how the backfill happens for existing rows, and TAR-47's column had none,
-- so leaving it would be drift the next `migrate dev` proposes to remove.
--
-- The one other thing it cannot restore is `action`'s **ordinal position**: it
-- comes back last rather than after `conditions`, because Postgres appends. No
-- query in this repository depends on column order — `SELECT *` is not in the
-- hot paths and Prisma names every column — and re-applying the up migration
-- drops it again, so the shape this file and `migration.sql` hand back and
-- forth is otherwise byte-identical.
--
-- **And what it gives up.** Between this file and a re-apply there is nothing
-- stopping two rules in one tenant from being named `Billing` and `billing`,
-- and nothing stopping an active rule from having two targets or none. If
-- either accumulates in that window it will block the way back in — which is
-- correct, and is the guard in `migration.sql` doing its job.
--
-- No `pnpm db:roles` re-run is needed after this, in either direction. No table
-- is created or dropped, so no grant and no policy changes, and
-- `verify-tenant-isolation.sql` derives its list from the catalog.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit. It is the same
-- `BEGIN;`/`COMMIT;` pair ten of the other `down.sql` files carry, so it is the
-- convention rather than a choice made here.
--
-- It is also safe under `db:rollback`, which used to open a transaction of its
-- own and had the `COMMIT` below end it early, leaving the bookkeeping delete
-- outside — TAR-346. The script now sends that delete and this file as one
-- statement batch, and the `BEGIN` below converts the batch's implicit
-- transaction rather than opening a second one, so both halves commit together.
-- What that relies on is the shape: one outermost `BEGIN` … `COMMIT` and
-- nothing after it. `db:check-migrations` fails on anything else.
--
-- Locks and duration mirror the up migration: ACCESS EXCLUSIVE on
-- `assignment_rules` for the whole file — `ALTER COLUMN … TYPE` and
-- `ADD COLUMN … NOT NULL DEFAULT` on a pre-13 shape both rewrite the table, and
-- on any current environment that is milliseconds because the table is empty.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- 4. The ordering index loses `id`.
DROP INDEX IF EXISTS "public"."assignment_rules_tenant_id_is_active_position_id_idx";

CREATE INDEX "assignment_rules_tenant_id_is_active_position_idx"
    ON "public"."assignment_rules" ("tenant_id", "is_active", "position");

-- 3. `action` comes back — empty. See the header.
ALTER TABLE "public"."assignment_rules"
    ADD COLUMN "action" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "public"."assignment_rules"
    ALTER COLUMN "action" DROP DEFAULT;

-- 2. The one-target rule goes.
ALTER TABLE "public"."assignment_rules"
    DROP CONSTRAINT IF EXISTS "assignment_rules_active_has_one_target";

-- 1. `name` goes back to case-sensitive `text`, not unique.
DROP INDEX IF EXISTS "public"."assignment_rules_tenant_id_name_key";

ALTER TABLE "public"."assignment_rules"
    ALTER COLUMN "name" SET DATA TYPE TEXT USING "name"::TEXT;

COMMIT;
