-- Reverses 20260816150000_canned_response_shortcut_and_bounds.
--
-- Restores the shape `20260810140000_tenant_isolation_rls` left on
-- `canned_responses`: `shortcut` back to `text` under a case-*sensitive*
-- `UNIQUE (tenant_id, shortcut)`, none of the four CHECK constraints, and the
-- two column comments cleared. Statements are in the reverse order of the up
-- migration, so nothing here depends on something this file has already removed.
--
-- **This one is lossless.** Unlike TAR-285's `down.sql`, the up migration
-- destroys nothing: it widens a type and adds constraints and comments. Every
-- statement below has an exact inverse, no row is rewritten with a placeholder,
-- and re-applying the up migration lands on a byte-identical shape. Column
-- ordinal positions are untouched — no column is added or dropped in either
-- direction.
--
-- `citext` → `text` cannot fail on data: every `citext` value is a well-formed
-- `text` value, and the rebuilt unique index is *less* restrictive than the one
-- it replaces, so no pair of existing rows can collide on the way back.
--
-- **What it gives up.** Between this file and a re-apply there is nothing
-- stopping two responses in one tenant from being `/Hours` and `/hours`, nothing
-- stopping a shortcut that the composer's picker can never reach, nothing
-- stopping an empty title or an unsendable 5 kB body, and nothing stopping an
-- `is_shared = false` row the read paths have no reader for. If any of those
-- accumulates in that window it will block the way back in — which is correct,
-- and is the guard in `migration.sql` doing its job.
--
-- The index `canned_responses_tenant_id_created_by_user_id_idx` is not mentioned
-- in either direction. The up migration deliberately leaves it in place (see its
-- header, section 4), so there is nothing here to restore.
--
-- No `pnpm db:roles` re-run is needed after this, in either direction. No table
-- is created or dropped, so no grant and no policy changes, and
-- `verify-tenant-isolation.sql` derives its list from the catalog.
-- `canned_responses` keeps `ENABLE`/`FORCE ROW LEVEL SECURITY` and its
-- `tenant_isolation` policy throughout — neither file touches them.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit. It is the same
-- `BEGIN;`/`COMMIT;` pair the other `down.sql` files carry, so it is the
-- convention rather than a choice made here.
--
-- It is also safe under `db:rollback`, which sends the bookkeeping delete and
-- this file as one statement batch: the `BEGIN` below converts that batch's
-- implicit transaction rather than opening a second one, so both halves commit
-- together (TAR-346). What that relies on is the shape — one outermost `BEGIN` …
-- `COMMIT` and nothing after it. `db:check-migrations` fails on anything else.
--
-- Locks and duration mirror the up migration: ACCESS EXCLUSIVE on
-- `canned_responses` for the whole file, because `ALTER COLUMN … TYPE` rewrites
-- the table and rebuilds the unique index. On any current environment that is
-- milliseconds, because the table is empty.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- The column comments go.
COMMENT ON COLUMN "public"."canned_responses"."shortcut" IS NULL;

COMMENT ON COLUMN "public"."canned_responses"."is_shared" IS NULL;

-- 2. The four bounds go.
ALTER TABLE "public"."canned_responses"
    DROP CONSTRAINT IF EXISTS "canned_responses_is_shared";

ALTER TABLE "public"."canned_responses"
    DROP CONSTRAINT IF EXISTS "canned_responses_body_length";

ALTER TABLE "public"."canned_responses"
    DROP CONSTRAINT IF EXISTS "canned_responses_title_length";

ALTER TABLE "public"."canned_responses"
    DROP CONSTRAINT IF EXISTS "canned_responses_shortcut_format";

-- 1. `shortcut` goes back to case-sensitive `text`. The unique index is rebuilt
--    by the rewrite, exactly as it was on the way in.
ALTER TABLE "public"."canned_responses"
    ALTER COLUMN "shortcut" SET DATA TYPE TEXT USING "shortcut"::TEXT;

COMMIT;
