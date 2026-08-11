-- Reverses 20260811160000_audit_actor_attribution.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- What this costs
-- ---------------------------------------------------------------------------
--
-- Lossless for everything written before the up migration: `actor_user_id`,
-- `action`, `target_type`, `target_id`, `metadata` and `created_at` are
-- untouched by both directions, so the audit trail as it stood is intact.
--
-- **It discards the attribution recorded since.** Every `actor_type` and every
-- `actor_label` written after the up migration ran goes with the columns, and
-- nothing else in the row holds the operator's label — so a WABA connected in
-- that window keeps its audit row and loses the answer to "which operator". That
-- is unrecoverable from the database alone; the application log line for the
-- connection is the only remaining trace, under its request id.
--
-- So: apply this to roll back a deploy, accepting that loss for the window.
-- Past that point the forward fix is a new migration.
--
-- Order matters: the constraint and the index reference the column, and the
-- column is typed on the enum, so all three go before the type.
--
-- Re-applying the up migration afterwards backfills `user` and `unattributed`
-- from what survives, exactly as it did the first time — which is the point of
-- the backfill deriving only from `actor_user_id` and never from a guess.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "public"."audit_logs"
    DROP CONSTRAINT IF EXISTS "audit_logs_actor_attribution";

DROP INDEX IF EXISTS "public"."audit_logs_tenant_id_actor_type_created_at_idx";

ALTER TABLE "public"."audit_logs"
    DROP COLUMN IF EXISTS "actor_label",
    DROP COLUMN IF EXISTS "actor_type";

DROP TYPE IF EXISTS "audit_actor_type";

COMMIT;
