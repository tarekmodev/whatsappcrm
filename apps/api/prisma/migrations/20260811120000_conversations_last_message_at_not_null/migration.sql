-- conversations.last_message_at becomes NOT NULL DEFAULT CURRENT_TIMESTAMP (TAR-92).
--
-- Ruled by the Architect in the TAR-20 thread as amendment 2 to
-- docs/architecture/0002-architecture-and-api-contract.md (the keyset-convention
-- nullability clause). The prose lands on the amendment branch; the schema and
-- the contract type land here, because a type is not prose.
--
-- ---------------------------------------------------------------------------
-- Why — a nullable column cannot lead a keyset index
-- ---------------------------------------------------------------------------
--
-- last_message_at is the leading *sort* column of all three inbox indexes:
--
--   conversations (tenant_id, status, last_message_at DESC, id DESC)
--   conversations (tenant_id, assigned_user_id, status, last_message_at DESC, id DESC)
--   conversations (tenant_id, assigned_team_id, status, last_message_at DESC, id DESC)
--
-- and 0002 rules the resume predicate for that sort as
--
--   last_message_at <= $1 AND NOT (last_message_at = $1 AND id >= $2)
--
-- A conversation with no message yet writes NULL there, and that breaks the
-- pagination twice over:
--
--   1. Postgres sorts NULLs FIRST under DESC. The message-less thread pins
--      itself to the top of page one, above every real conversation, which is
--      wrong on its own.
--   2. `NULL <= $1` is NULL, not TRUE, and `NOT (NULL …)` is NULL too. Once the
--      cursor lands on that row, the WHERE clause is unknown for it — and for
--      every row the scan reaches afterwards that shares the fault. The page
--      comes back short or empty, with no error. A list that silently stops is
--      the failure mode 0002 names explicitly: "no error, a row simply never
--      appears".
--
-- COALESCE in the query is not the fix. Wrapping the indexed column in a
-- function makes the predicate unsargable, which costs exactly the index scan
-- the whole convention exists to keep. The value belongs in the column.
--
-- Semantics: a thread with no message yet sorts by when it was opened, so the
-- default is the row's own insert time and the backfill is created_at. That is
-- the correct value, not a filler — an empty conversation genuinely has no
-- activity more recent than its creation.
--
-- ---------------------------------------------------------------------------
-- Why the simple SET NOT NULL and not the online CHECK-first form
-- ---------------------------------------------------------------------------
--
-- Because conversations is empty. TAR-20 has not shipped, no code writes the
-- column, and `SELECT count(*)` is 0 in every environment. SET NOT NULL takes
-- ACCESS EXCLUSIVE and scans the table to prove no NULL exists; over zero rows
-- that scan is sub-millisecond, so the online form (NOT VALID CHECK → batched
-- backfill → VALIDATE → SET NOT NULL → DROP CONSTRAINT) would buy nothing and
-- cost five statements and a deploy. Decided in the TAR-20 thread.
--
-- If real data lands here before this migration is applied anywhere, do NOT
-- keep this form — the ACCESS EXCLUSIVE scan then blocks every reader of the
-- hottest table in the product for its duration. Redo it as the online form.
-- The UPDATE below stays correct either way; it is written as one statement
-- precisely because it can only ever touch zero rows here.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Zero rows to backfill, zero rows to verify.
--   Locks        ACCESS EXCLUSIVE on conversations, held to commit (Prisma runs
--                a migration in one transaction). No index is rebuilt: the
--                existing btree stays valid, and with no NULLs its NULLS FIRST
--                ordering is unobservable.
--   Blocking     lock_timeout caps the wait at three seconds, so a conflicting
--                long-running transaction aborts this migration cleanly rather
--                than queueing ahead of every new query on conversations.
--                Re-run once it clears.
--   Write cost   None. A column default is not a per-row write, and NOT NULL is
--                a catalogue flag checked in memory.
--   Data loss    None. Nothing is dropped and no existing value is overwritten
--                — the UPDATE is guarded by `WHERE last_message_at IS NULL`.
--   Rollback     down.sql beside this file. See its header for the one thing
--                that does not reverse.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Backfill, before the constraint that depends on it.
-- ---------------------------------------------------------------------------
--
-- Expected to touch zero rows. It is here because "expected" is not "verified",
-- and because a migration that is only correct against an empty table should
-- still be correct against a full one.
--
-- The FORCE ROW LEVEL SECURITY toggle is the same manoeuvre TAR-52's guard uses,
-- for the same reason: the migration owner is not exempt from FORCE, and no
-- app.tenant_id GUC is set here, so the tenant_isolation policy matches nothing
-- and a plain UPDATE would report `UPDATE 0` on a table full of NULLs. It would
-- not corrupt anything — SET NOT NULL scans below RLS and would abort on the
-- rows the UPDATE never reached — but it would fail with "column contains null
-- values" instead of doing the job, which is a confusing way to find out.
--
-- Safe inline: DDL is transactional in Postgres, this migration already holds
-- ACCESS EXCLUSIVE on conversations for its whole duration so no other session
-- can read the table while FORCE is off, and an abort rolls the toggle back with
-- everything else.
DO $$
DECLARE
    backfilled bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."conversations" NO FORCE ROW LEVEL SECURITY';

    UPDATE "public"."conversations"
       SET "last_message_at" = "created_at"
     WHERE "last_message_at" IS NULL;

    GET DIAGNOSTICS backfilled = ROW_COUNT;

    EXECUTE 'ALTER TABLE "public"."conversations" FORCE ROW LEVEL SECURITY';

    IF backfilled > 0 THEN
        -- Not a failure: the migration is still correct. But it means this
        -- table was not empty, which is the assumption the simple SET NOT NULL
        -- form above rests on — worth seeing in the deploy log.
        RAISE NOTICE
            'TAR-92 backfilled % conversation(s) from created_at; the table was not empty, '
            'so the ACCESS EXCLUSIVE scan below was not free.', backfilled;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Schema change. Generated by `prisma migrate diff`, read before committing.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "public"."conversations" ALTER COLUMN "last_message_at" SET NOT NULL,
ALTER COLUMN "last_message_at" SET DEFAULT CURRENT_TIMESTAMP;
