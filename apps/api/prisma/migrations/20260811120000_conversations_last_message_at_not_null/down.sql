-- Reverses 20260811120000_conversations_last_message_at_not_null.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6). The two
-- ALTERs below are exactly what `prisma migrate diff --from-schema
-- prisma/schema.prisma --to-migrations prisma/migrations --script` produced
-- before the migration directory existed, read rather than assumed.
--
-- ---------------------------------------------------------------------------
-- What this destroys
-- ---------------------------------------------------------------------------
--
-- Nothing. No column is dropped and no value is deleted; the two flags are
-- catalogue state, and dropping them is instant.
--
-- The one thing that does not reverse is the up migration's backfill. A row it
-- set to created_at is indistinguishable afterwards from one that legitimately
-- has last_message_at = created_at, so running this file does not restore those
-- NULLs. That is not a data-loss concern — for a message-less thread,
-- last_message_at = created_at is the semantically correct value either way —
-- but the rollback is a schema rollback, not a total one, and saying so is
-- cheaper than someone discovering it.
--
-- ⚠️ Reverting this reintroduces the defect it fixed. Any inbox query paginating
-- over (tenant_id, status, last_message_at DESC, id DESC) with the ruled keyset
-- predicate starts silently dropping rows again the moment a message-less
-- conversation exists. If the reason for reverting is anything other than
-- "unwinding this whole change set", fix forward instead.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Neither statement scans or rewrites the table.
--   Locks        ACCESS EXCLUSIVE on conversations for the transaction.
--   Blocking     Not an online operation — a reader mid-statement waits, and
--                lock_timeout aborts this rather than queueing behind a long
--                transaction.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit — without it a
-- failure between the two statements would leave the column NOT NULL with no
-- default, and `SET LOCAL lock_timeout` would be a no-op warning rather than a
-- limit.
--
-- Not applied automatically — see the "Rolling a migration back" section of
-- README.md, including the `_prisma_migrations` row that has to be deleted
-- afterwards.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- AlterTable
ALTER TABLE "public"."conversations" ALTER COLUMN "last_message_at" DROP NOT NULL,
ALTER COLUMN "last_message_at" DROP DEFAULT;

COMMIT;
