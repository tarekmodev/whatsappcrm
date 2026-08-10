-- conversations.last_message_at becomes NOT NULL (TAR-20a, amendment 2).
--
-- The column leads the inbox's keyset sort:
--
--   conversations (tenant_id, status, last_message_at DESC, id DESC)
--
-- and amendment 2 rules that a keyset sort column is NOT NULL. Under
-- three-valued logic the ruled resume predicate
--
--   last_message_at <= $1 AND NOT (last_message_at = $1 AND id >= $2)
--
-- evaluates to NULL for a row whose last_message_at is NULL — not true, so the
-- row is filtered out. It appears on page one, where there is no cursor and
-- therefore no predicate, and on no page after it. Silent: an empty page reads
-- as the end of the list.
--
-- Postgres also sorts NULL first under DESC, so the same row sits pinned above
-- every active thread on page one before it disappears.
--
-- ---------------------------------------------------------------------------
-- Why this is one migration and not expand -> backfill -> contract
-- ---------------------------------------------------------------------------
--
-- The column is not being added, moved or dropped: it is being narrowed, and a
-- narrowing has no dual-write phase to stage. The backfill below is written to
-- be correct on a populated table anyway, so this file does not depend on the
-- table being empty and carries no guard refusing to run if it is not. What it
-- does depend on is that nothing is concurrently inserting NULLs, which
-- ACCESS EXCLUSIVE guarantees for its duration.
--
-- No DEFAULT is added, deliberately. `NOT NULL DEFAULT created_at` was the
-- shape first proposed and is not expressible — a Postgres column default
-- cannot reference another column of the same row — and the obvious substitute,
-- DEFAULT CURRENT_TIMESTAMP, is worse than nothing here. It makes the field
-- optional in Prisma's create input, so an insert that omits it records the
-- row's creation time as message activity; the ingest path advances
-- last_message_at only when the incoming message is newer, and Meta's
-- provider timestamp is always older than the moment we process it. The first
-- message in every conversation would then fail that comparison. Required, with
-- no default, makes an insert that has not decided the value a compile error.
--
-- ---------------------------------------------------------------------------
-- The backfill and row-level security
-- ---------------------------------------------------------------------------
--
-- `conversations` is FORCE ROW LEVEL SECURITY (TAR-48), and FORCE means the
-- table owner is not exempt — migrations run as the owner (app-roles.sql).
-- With no `app.tenant_id` GUC set on this connection the tenant_isolation
-- policy matches nothing, so a plain UPDATE here reports 0 rows on a full table
-- and then SET NOT NULL fails on the rows the UPDATE could not see.
--
-- ⚠️ That failure is environment-dependent, which is the trap. SUPERUSER and
-- BYPASSRLS skip policy evaluation entirely, so the naive form appears to work
-- wherever migrations run as a superuser — including `postgres` in
-- docker-compose and in CI. Both forms were run here against Postgres 17: as
-- `postgres` the untoggled UPDATE reported 2 rows; as a NOSUPERUSER NOBYPASSRLS
-- table owner, the shape a managed Postgres deploy user actually has, the same
-- statement reported 0 and the following SET NOT NULL aborted with "column
-- last_message_at contains null values". A migration that backfills a
-- FORCE-RLS table and is only ever exercised locally is therefore untested
-- against the one environment where it matters.
--
-- So the backfill runs with FORCE suspended, exactly as TAR-52's guard does and
-- for the same reasons: `ALTER TABLE ... NO FORCE` itself takes ACCESS
-- EXCLUSIVE, so from that statement to commit no other session can read the
-- table while the policy is off; DDL is transactional in Postgres and Prisma
-- runs each migration in one transaction, so any abort restores FORCE with
-- everything else.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
-- Locks:     ACCESS EXCLUSIVE on conversations, held for the whole file.
--            SHARE lock on messages for the backfill's subquery.
-- Duration:  sub-millisecond at present (the table is empty and nothing writes
--            the column on main). On a populated table it is one sequential
--            scan of conversations plus one index-only lookup per NULL row
--            against messages (tenant_id, conversation_id, sent_at DESC, id
--            DESC), then a second scan for SET NOT NULL's validation.
-- Blocking:  total for its duration — readers included. lock_timeout is set so
--            it fails fast rather than queueing behind a long read and parking
--            every subsequent query behind its own lock request.
-- Writes:    no index is rebuilt. The existing DESC index stays valid, and with
--            no NULLs left its NULLS FIRST ordering is unobservable.
--
-- If this ever needs to run against a conversations table large enough that a
-- blocking scan is unacceptable, the non-blocking form is: ADD CONSTRAINT ...
-- CHECK (last_message_at IS NOT NULL) NOT VALID (instant), backfill in bounded
-- batches in separate transactions, VALIDATE CONSTRAINT (SHARE UPDATE
-- EXCLUSIVE, non-blocking), then SET NOT NULL, which Postgres 12+ takes as
-- proven by the validated CHECK and so skips its own scan. That is three
-- deploys rather than one and is not warranted at this size.
--
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Backfill. Correct on a populated table, a no-op on an empty one.
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."conversations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."messages" NO FORCE ROW LEVEL SECURITY;

-- A NULL here means "no message has advanced this row". Usually that is a
-- thread with no messages, and created_at is what the inbox should sort it by.
-- The subquery covers the other case rather than assuming it away: a row that
-- does have messages but was never advanced is a bug elsewhere, and dating it
-- from its newest message is the repair. COALESCE resolves to created_at
-- whenever there are no messages, which today is every row.
UPDATE "public"."conversations" c
SET "last_message_at" = COALESCE(
    (
        SELECT max(m."sent_at")
        FROM "public"."messages" m
        WHERE m."tenant_id" = c."tenant_id"
          AND m."conversation_id" = c."id"
    ),
    c."created_at"
)
WHERE c."last_message_at" IS NULL;

ALTER TABLE "public"."messages" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."conversations" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Schema change.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "public"."conversations" ALTER COLUMN "last_message_at" SET NOT NULL;
