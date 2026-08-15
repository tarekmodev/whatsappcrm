-- The three pieces of ADR 0009's phase-2a schema that TAR-403 did not carry, and
-- that TAR-404's engine reads and writes on its first commit (TAR-413 review
-- follow-up).
--
--   1. `lifecycle_trigger` + `lifecycle_audit_log.trigger` — 0009 line 600. The
--      column that makes "no `active → past_due` from a button" assertable
--      rather than aspirational (0009 line 134), and the field PR #127's
--      `TenantLifecycleEventSchema` already publishes as required.
--   2. `lifecycle_audit_log.notified_at` — 0009 lines 499–502 and 612. The
--      notification backstop: the row is the truth, the queue is an accelerator.
--      Adding the column is only half of it — the append-only trigger as TAR-403
--      shipped it refuses *every* UPDATE, so the one-way stamp is narrowed into
--      the trigger below rather than left as a column nothing may ever set.
--   3. `tenants.purge_started_at` — 0009 line 569. What makes a crashed purge
--      resumable rather than restartable, and what distinguishes a half-purged
--      tenant from a queued one for the stuck-purge alert (0009 line 824).
--
-- All three are additive. Nothing here changes the meaning of a column that
-- exists, and nothing here reads or writes tenant data.
--
-- ---------------------------------------------------------------------------
-- What is deliberately NOT in this file
-- ---------------------------------------------------------------------------
--
-- **The `suspended` gate.** 0009 decision 2 replaces `assert_tenant_active` with
-- `assert_tenant_serviceable` so a suspended tenant's inbound WhatsApp messages
-- can still be stored. That is a change to a security gate every request passes
-- through, it needs the application's call sites moved with it, and it is the
-- first of the four questions TAR-413 put to TAR-397's owner. It lives in
-- `20260815170000_assert_tenant_serviceable` so it can be held, reviewed or
-- reverted without holding these three columns, which nothing disputes.
--
-- **Narrowing the two sweeper indexes** to 0009's `status IN (...)` predicates
-- (lines 577–580). TAR-413 called it "worth folding in if a migration is opening
-- anyway", and it is not, yet: TAR-404's sweep queries are unwritten, and a
-- partial index whose predicate the eventual `WHERE` clause does not restate is
-- an index the planner cannot use. Narrow it against the real query, in the PR
-- that writes the query.
--
-- **A CHECK tying `purge_started_at` to `deleted_at` or `purge_at`.** The
-- ordering — stamp, then delete, then tombstone — is the engine's invariant, not
-- the schema's, and a database where a purge completed before this column
-- existed would fail the validation on a constraint that describes a rule it
-- predates.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Both `ADD COLUMN`s take PostgreSQL 11+'s
--                non-rewriting path (`attmissingval`): the defaults below are
--                constant and stable, so each is a catalog update regardless of
--                row count. The one index build is sized by the number of
--                `lifecycle_audit_log` rows, which is a handful per tenant over
--                a tenant's whole life.
--   Locks        ACCESS EXCLUSIVE on `lifecycle_audit_log` and on `tenants`, for
--                the ALTERs and the index build, held to the end of the
--                transaction as Prisma wraps the file in one. Capped at three
--                seconds by `lock_timeout`.
--   Blocking     A tenant-facing request touching `tenants` — which is every
--                request, through the gate — queues behind the ALTER for those
--                milliseconds. `lock_timeout` makes a blocked migration abort
--                rather than stack requests behind it.
--   Rewrite      None. Confirmed by the column list: `trigger` and `notified_at`
--                take constant defaults, `purge_started_at` is nullable with no
--                default.
--   Rollback     `down.sql` beside this file. Reversible with one documented
--                loss, named there.
--
-- ---------------------------------------------------------------------------
-- Re-run `pnpm db:roles` after applying this
-- ---------------------------------------------------------------------------
--
-- `app-roles.sql` is amended in the same commit with a **column-level**
-- `GRANT UPDATE ("notified_at")` to `whatsappcrm_system`. Until it is re-run the
-- new column is readable and writable at insert but can never be stamped, and
-- the notification backstop is a column with no writer. Table-level UPDATE stays
-- withheld from both roles, which is what keeps every other column append-only.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. `lifecycle_trigger`
-- ---------------------------------------------------------------------------
--
-- The five causes 0009 line 600 names, in its order. A fresh `CREATE TYPE` and
-- not `ALTER TYPE ... ADD VALUE`, so — unlike `20260815120000` — its labels are
-- usable in the transaction that creates them and this needs no directory of its
-- own.
--
-- The vocabulary answers "what kind of thing caused this edge", which is a
-- different question from `actor_type`'s "who". They are not redundant: an
-- operator can cause a `billing_event` by hand-posting a webhook, and a `timer`
-- fires with `actor_type = 'system'` and no actor at all. Both columns are
-- needed to say that a transition was legitimate.
CREATE TYPE "public"."lifecycle_trigger" AS ENUM (
    'user_action',
    'operator_action',
    'billing_event',
    'timer',
    'system'
);

COMMENT ON TYPE "public"."lifecycle_trigger" IS
    'TAR-413 follow-up to TAR-403, per ADR 0009. What kind of event caused a lifecycle edge — '
    'distinct from audit_actor_type, which says who. Matches LIFECYCLE_TRIGGERS in '
    '@whatsappcrm/contracts exactly.';

-- ---------------------------------------------------------------------------
-- 2. `lifecycle_audit_log.trigger`
-- ---------------------------------------------------------------------------
--
-- `NOT NULL`, because the contract publishes it as required and because a
-- nullable trigger column is a trigger column the transition function can forget
-- to write — which is the failure this column exists to make impossible.
--
-- The default exists only to fill the rows already in the table, and is dropped
-- immediately after. That is what keeps this a catalog-only ALTER: PostgreSQL
-- stores one constant in `pg_attribute.attmissingval` rather than rewriting the
-- heap, and — the part that matters here — **no row is UPDATEd**, so the
-- append-only trigger never fires. A backfill written as an `UPDATE` would raise
-- `TN002` on its first row.
--
-- `system` for those rows and not a sixth `unattributed` label: the rows TAR-403
-- backfilled are one genesis row per tenant, recording a state the platform
-- itself put the row in. `system` is 0009's own reading of that case — "the
-- platform itself, with no actor". Their `actor_type` stays `unattributed`,
-- which is the honest answer to the different question of who.
--
-- Dropping the default afterwards is the same discipline `actor_type` follows:
-- every writer states the trigger or the insert fails. A default would let
-- TAR-404 write `system` by omission for an edge a person caused.
ALTER TABLE "public"."lifecycle_audit_log"
    ADD COLUMN "trigger" "public"."lifecycle_trigger" NOT NULL DEFAULT 'system';

ALTER TABLE "public"."lifecycle_audit_log"
    ALTER COLUMN "trigger" DROP DEFAULT;

COMMENT ON COLUMN "public"."lifecycle_audit_log"."trigger" IS
    'TAR-413 follow-up. What caused this edge (ADR 0009 line 600). No default: every writer '
    'states it, which is what makes "no active → past_due from a button" assertable. Rows '
    'backfilled by TAR-403 carry `system` — the platform put them in the state they record.';

-- ---------------------------------------------------------------------------
-- 3. `lifecycle_audit_log.notified_at`
-- ---------------------------------------------------------------------------
--
-- The backstop 0009 decision 7 describes: the sweep re-enqueues any row still
-- holding `NULL` a minute after it was written, so a transition committed while
-- Redis is unavailable still notifies. **NULL means a notification is owed.**
--
-- Existing rows are stamped rather than left NULL, and the two-step default is
-- how: a constant default fills every row already present, and dropping it
-- leaves new rows NULL. A row that skipped the stamp would be a row the very
-- first sweep re-enqueues — so TAR-403's genesis backfill would email every
-- tenant admin about a transition that happened before the mechanism existed.
--
-- The value it stamps them with is this migration's instant, and it is a claim
-- about the debt rather than about the past: nothing notified anyone for these
-- rows, and nothing should. `occurred_at` would read as though something had.
ALTER TABLE "public"."lifecycle_audit_log"
    ADD COLUMN "notified_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "public"."lifecycle_audit_log"
    ALTER COLUMN "notified_at" DROP DEFAULT;

COMMENT ON COLUMN "public"."lifecycle_audit_log"."notified_at" IS
    'TAR-413 follow-up. When the tenant-admin notification for this transition was sent. NULL '
    'means one is owed and the sweep will re-enqueue it (ADR 0009 decision 7). The single '
    'column on this table that may ever be UPDATEd, and only NULL → value, once.';

-- The sweep's query: rows still owing a notification, oldest first, across every
-- tenant.
--
-- Predicated on `notified_at IS NULL` and keyed on **`occurred_at`**, which is
-- where this departs from 0009 line 610's "(notified_at) partial on notified_at
-- IS NULL". Indexing the predicate column is indexing a column that is NULL for
-- every row in the index: the entries carry no orderable value, so the "older
-- than a minute" bound and the ordering both fall back to a filter on the heap.
-- `occurred_at` is the column the sweep actually compares and orders by, so the
-- scan stops at the first row younger than the cutoff.
--
-- Partial, and that is what makes it nearly free: a row is in this index only
-- between being written and being notified — seconds, normally — so it holds the
-- backlog rather than the history, and the stamp that settles a row removes it.
CREATE INDEX "lifecycle_audit_log_notified_at_pending_idx"
    ON "public"."lifecycle_audit_log"("occurred_at")
    WHERE "notified_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 4. The append-only trigger learns the one exception
-- ---------------------------------------------------------------------------
--
-- TAR-403's trigger raises `TN002` on every UPDATE unconditionally, which is
-- correct for every column except the one added above — and would make
-- `notified_at` a column that can be read, inserted and never stamped.
--
-- The narrowing is stated as "everything except `notified_at` is unchanged"
-- rather than as a list of columns, and that is deliberate: a column added by a
-- later migration is covered by this function on the day it is added, with
-- nobody having to remember to extend a list. `probe` is `NEW` with only
-- `notified_at` put back to its old value; if that still differs from `OLD` in
-- any way, something other than the stamp was edited and the update is refused.
--
-- The direction is one-way: `OLD.notified_at IS NULL` is required, so a stamp
-- can be set once and never moved, cleared or re-set. That is what keeps it a
-- stamp rather than a mutable column on an append-only table.
--
-- `CREATE OR REPLACE`, so the grants on the function are undisturbed and the
-- trigger definition itself does not change — the trigger still fires
-- `BEFORE UPDATE ... FOR EACH ROW`, and the decision moves into the body where
-- it can compare the two rows. A `WHEN` clause cannot express "every other
-- column is unchanged" without naming them all.
--
-- DELETE stays unblocked, for the reason TAR-403 gives at length: it is
-- reachable only through the referential cascade from `tenants`, which a row
-- trigger cannot tell apart from a hand-written statement.
CREATE OR REPLACE FUNCTION "public"."lifecycle_audit_log_forbid_update"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    probe "public"."lifecycle_audit_log";
BEGIN
    IF OLD."notified_at" IS NULL AND NEW."notified_at" IS NOT NULL THEN
        probe := NEW;
        probe."notified_at" := OLD."notified_at";

        IF probe IS NOT DISTINCT FROM OLD THEN
            RETURN NEW;
        END IF;
    END IF;

    RAISE EXCEPTION 'lifecycle_audit_log is append-only: row % cannot be updated', OLD."id"
        USING ERRCODE = 'TN002',
              HINT = 'Only notified_at may be UPDATEd, once, from NULL. Record a correction as a '
                     'new transition instead of editing the old one.';
END;
$$;

COMMENT ON FUNCTION "public"."lifecycle_audit_log_forbid_update"() IS
    'TAR-403, narrowed by TAR-413''s follow-up. Raises TN002 on any UPDATE of lifecycle_audit_log, '
    'including by the table owner, with one exception: stamping notified_at from NULL to a value '
    'while every other column stays identical. DELETE is intentionally not blocked — it is '
    'reachable only by the ON DELETE CASCADE from tenants, which a row trigger cannot tell apart '
    'from a hand-written statement.';

-- ---------------------------------------------------------------------------
-- 5. `tenants.purge_started_at`
-- ---------------------------------------------------------------------------
--
-- Without it, the sweep cannot tell a purge that crashed half-way from one that
-- has not begun: both read `status = 'suspended'`, `purge_at` elapsed,
-- `deleted_at` NULL. It restarts from the first batch, and the stuck-purge alert
-- 0009 line 824 asks for has no condition to fire on.
--
-- No index. The sweep already finds these rows through `tenants_purge_at_idx`
-- and reads this column off the row it has; an index on a column that is NULL
-- for all but a handful of tenants at any instant would cost a write per purge
-- and never be chosen.
ALTER TABLE "public"."tenants"
    ADD COLUMN "purge_started_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN "public"."tenants"."purge_started_at" IS
    'TAR-413 follow-up. When the first purge batch began (ADR 0009 line 569), stamped in the same '
    'transaction that enqueues the tenant_deleted email and before the first DELETE. Lets a '
    'crashed purge resume rather than restart, and distinguishes a half-purged tenant from a '
    'queued one for the stuck-purge alert. NULL until the purge starts.';
