-- Who acted, on every audit row (TAR-166, amendment 2 of
-- `docs/architecture/0002-architecture-and-api-contract.md`).
--
-- `audit_logs.actor_user_id` answers "which user in this tenant", and NULL there
-- has been carrying two entirely different meanings: the platform acted, or
-- nothing recorded who. Connecting a WhatsApp Business Account hands the
-- platform a credential that can message a business's customers in its name, and
-- today the row that records it is indistinguishable from a row nobody attributed
-- at all. Two columns close that.
--
--   1. `actor_type`   `user | platform_operator | system | unattributed`.
--   2. `actor_label`  Names the operator credential when `actor_type` is
--                     `platform_operator`. NULL otherwise.
--
-- ---------------------------------------------------------------------------
-- Columns rather than a `metadata` key
-- ---------------------------------------------------------------------------
--
-- "Everything this operator did" is the query these exist to answer, and
-- `audit_logs` is the table a compliance reviewer filters for a living. A `jsonb`
-- key cannot lead an index and cannot carry a constraint; two typed columns and
-- `(tenant_id, actor_type, created_at DESC)` can, and the answer stays an index
-- scan as the table grows.
--
-- ---------------------------------------------------------------------------
-- The backfill does not invent an attribution
-- ---------------------------------------------------------------------------
--
-- A row that already names a user is `user` — that fact was recorded when the
-- row was written and is not being guessed at now. Every other existing row
-- becomes `unattributed`, which is the honest reading: at the time it was
-- written, nothing recorded who. Back-dating those to `platform_operator` would
-- put a claim in the audit trail that nobody made.
--
-- ---------------------------------------------------------------------------
-- Why `actor_type` carries a DEFAULT, and what that default is for
-- ---------------------------------------------------------------------------
--
-- Application code never relies on it: `AuditService` resolves the actor from
-- the request scope and writes all three columns explicitly, and the type it
-- writes from excludes `unattributed` so no new path can choose it.
--
-- The default exists for the rollout window. This migration is applied before
-- the release that writes the column, so for the length of the deploy the
-- previous instance is still inserting audit rows with no `actor_type` at all. A
-- NOT NULL column with no default would fail those inserts — and each of them is
-- inside the transaction of the change it describes, so a role change or a
-- lockout would fail with it. What the default writes for those rows is exactly
-- what they are: unattributed.
--
-- ---------------------------------------------------------------------------
-- The constraint, and what it forbids
-- ---------------------------------------------------------------------------
--
-- `audit_logs_actor_attribution` makes the three columns agree with each other:
-- a `user` row names a user and carries no label, a `platform_operator` row
-- carries a label and names no user, and a `system` row carries neither. Without
-- it, "which operator connected this WABA" could answer with a label written
-- onto a row attributed to a tenant user — a wrong answer in the table whose
-- whole value is being right.
--
-- `unattributed` is deliberately looser: it forbids a label and says nothing
-- about `actor_user_id`, because a pre-release instance writing during the
-- rollout produces exactly that combination and the alternative is failing its
-- insert. Re-running the backfill statement above after the rollout has finished
-- promotes those rows to `user`; that is what makes the whole file worth being
-- re-runnable rather than only safe to re-run.
--
-- Prisma's schema language has no syntax for a CHECK constraint, so it lives
-- here and not in `schema.prisma`. Prisma's Postgres describer ignores check
-- constraints, so `migrate dev` proposes neither to create nor to drop it and
-- this is not drift — the same arrangement the predicated indexes in
-- `20260811130000` and `20260811150000` document. The consequence worth knowing:
-- nothing regenerates it from `schema.prisma` alone.
--
-- If a later story needs an operator acting *through* a tenant user — an
-- impersonation session — this constraint is what it has to amend, deliberately,
-- rather than a rule it can drift past unnoticed.
--
-- ---------------------------------------------------------------------------
-- Re-running this file
-- ---------------------------------------------------------------------------
--
-- Every statement is guarded, so a runner that stopped halfway through the fleet
-- and was restarted succeeds quietly rather than erroring. The backfill is
-- restricted to `unattributed` rows, so a second run cannot rewrite an
-- attribution the application has since made.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. `audit_logs` holds only seeded rows in every
--                environment this is applied to; the ALTER is a catalogue
--                update, and both the backfill and the constraint's validating
--                scan touch that same handful of rows. Expected runtime on the
--                largest tenant: unchanged — one shared database, and the table
--                is scanned once either way.
--   Locks        ACCESS EXCLUSIVE on `audit_logs`, held to commit. The index is
--                built non-concurrently, which is correct only while the table
--                is small; against a populated `audit_logs` it belongs in an
--                out-of-band `CREATE INDEX CONCURRENTLY` outside a transaction.
--   Blocking     `lock_timeout` caps the wait at three seconds, so a conflicting
--                long-running transaction aborts this migration cleanly rather
--                than queueing ahead of every write to the table. Re-run once it
--                clears.
--   Data loss    None. Additive only: two new columns, one index, one
--                constraint. No column is dropped, renamed, retyped or
--                overwritten.
--   Rollback     `down.sql` beside this file. Lossless for anything written
--                before this migration; see its header for what it discards.

SET LOCAL lock_timeout = '3s';

-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM "pg_type" WHERE "typname" = 'audit_actor_type') THEN
        CREATE TYPE "audit_actor_type" AS ENUM ('user', 'platform_operator', 'system', 'unattributed');
    END IF;
END
$$;

-- AlterTable
ALTER TABLE "audit_logs"
    ADD COLUMN IF NOT EXISTS "actor_type" "audit_actor_type" NOT NULL DEFAULT 'unattributed',
    ADD COLUMN IF NOT EXISTS "actor_label" TEXT;

-- Backfill. Only what the row already recorded; see the header.
UPDATE "audit_logs"
SET "actor_type" = 'user'
WHERE "actor_user_id" IS NOT NULL
  AND "actor_type" = 'unattributed';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_tenant_id_actor_type_created_at_idx"
    ON "audit_logs" ("tenant_id", "actor_type", "created_at" DESC);

-- AddConstraint. Dropped first so the file is safe to re-run; the table is small
-- enough that the revalidating scan costs nothing.
ALTER TABLE "audit_logs"
    DROP CONSTRAINT IF EXISTS "audit_logs_actor_attribution";

ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_actor_attribution" CHECK (
        CASE "actor_type"
            WHEN 'user' THEN "actor_user_id" IS NOT NULL AND "actor_label" IS NULL
            WHEN 'platform_operator' THEN "actor_user_id" IS NULL AND "actor_label" IS NOT NULL
            WHEN 'system' THEN "actor_user_id" IS NULL AND "actor_label" IS NULL
            -- `unattributed` says nothing about `actor_user_id`, and that is the
            -- rollout window rather than a loose end: an instance predating this
            -- release writes a user id and no `actor_type`, so the default fires
            -- and the row is a named user under an unattributed type. Forbidding
            -- that would fail the insert — and with it the role change or lockout
            -- whose transaction it sits in. `actor_label` is still refused,
            -- because nothing can write one without also writing a type.
            ELSE "actor_label" IS NULL
        END
    );
