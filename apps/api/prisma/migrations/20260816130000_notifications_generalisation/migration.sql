-- `sla_alerts` becomes `notifications` (TAR-394, implementing 0009 decision 7).
--
-- 0006 decision 5 rejected building a generic notifications table and said, in as
-- many words, what should happen when the second type arrived: "generalising it is
-- a rename and a `type` column". TAR-27's `notify` action is that second type, and
-- this is that rename. The alternative — a `workflow_notifications` table with the
-- same five meaningful columns — is a second unread count, a second acknowledge
-- endpoint, and a supervisor who has to look in two places.
--
-- **This is the one part of TAR-394 that touches a `done` story (TAR-26), and it
-- is deliberately a separate, independently landable migration** so that it can be
-- reviewed, applied or reverted on its own. Nothing in
-- 20260816140000_workflow_rule_schema depends on it.
--
-- ---------------------------------------------------------------------------
-- What changes, and what deliberately does not
-- ---------------------------------------------------------------------------
--
--   1. `ALTER TABLE ... RENAME TO`, plus the primary key, three indexes and four
--      foreign keys renamed to match. Renaming the table alone would leave
--      `sla_alerts_pkey` on `notifications`, which every later `migrate dev`
--      reports as drift and proposes to rename anyway.
--   2. `type notification_type NOT NULL DEFAULT 'sla_breach'`. The default is what
--      makes this a metadata-only migration: every existing row already *is* that
--      type, so no row is read and no backfill runs. The default **stays**
--      afterwards rather than being dropped, so a writer that forgets the column
--      lands on the type whose CHECK requires an `sla_timer_id` and fails loudly.
--   3. `sla_timer_id`, `kind` and `due_at` become nullable — they are the
--      `sla_breach` fields — behind `notifications_sla_breach_columns`, which makes
--      "non-null exactly for that type" an invariant rather than a convention.
--   4. `data JSONB` for the type-specific payload (`{ workflowId, workflowRunId }`),
--      and `dedupe_key TEXT` with a unique index per recipient: the workflow types'
--      second idempotency layer, mirroring the SLA unique already there.
--
-- Not changed, and each is a decision:
--
--   * **`ticket_id` stays NOT NULL.** Every type this story adds is raised while
--     evaluating one ticket, and `workflow_broken` is raised from the run that
--     failed, which has one. Making it nullable would be modelling a notification
--     type that does not exist yet, and un-nullifying a column later needs a
--     backfill this one does not.
--   * **`GET /api/v1/sla-alerts` and its acknowledge keep their paths, their
--     response shape and their behaviour**, as a documented `type = 'sla_breach'`
--     view over these rows. No frontend change, no contract change.
--   * **No `type` column in any index.** The recipient's list index
--     `(tenant_id, recipient_user_id, created_at DESC, id DESC)` serves both
--     endpoints; the SLA view adds `type = 'sla_breach'` as a filter over a set
--     already bounded by one recipient and one page. Putting `type` in the middle
--     of that index would serve the narrower read and cost the wider one its sort
--     order, which is the wrong trade for a filter this cheap. Revisit if a tenant
--     accumulates enough non-breach notifications for a page of alerts to walk
--     past thousands of them.
--   * **Neither unique index is partial**, where 0009 proposed
--     `WHERE sla_timer_id IS NOT NULL` and `WHERE dedupe_key IS NOT NULL`.
--     PostgreSQL does not collide NULLs, so both predicates are belt and braces
--     rather than behaviour — 0009 says as much for the first one. Adding them
--     would buy nothing and cost the trap this schema keeps paying for: Prisma's
--     describer skips predicated indexes, so a partial unique index cannot be
--     declared in `schema.prisma` and the next `migrate dev` proposes creating a
--     second, non-partial one beside it. Recorded here because it is a deliberate
--     divergence from the published contract, not an oversight.
--
-- ---------------------------------------------------------------------------
-- Row-level security, grants and the isolation test
-- ---------------------------------------------------------------------------
--
-- A rename carries all three: policies, privileges and the `tenant_isolation` and
-- `system_unrestricted` policies are attached to the table's OID, not its name, so
-- **no `pnpm db:roles` re-run is needed** and `pnpm db:verify:rls` keeps deriving
-- its list from the catalog. What does need editing is the by-name half of that
-- script, and this migration lands with it: `verify-tenant-isolation.sql` now
-- writes, reads and acknowledges `notifications`.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds at any table size. Every statement here is a
--                catalogue change: a rename, three `ADD COLUMN` with either no
--                default or a constant one (Postgres 11+ does not rewrite for
--                those), three `DROP NOT NULL`, and one CHECK plus one index over
--                a table holding at most a handful of seeded alerts.
--   Locks        ACCESS EXCLUSIVE on `notifications` for the file's duration.
--                Brief locks on `sla_timers`, `tickets`, `users` and `tenants` are
--                *not* taken: no foreign key is added, altered or revalidated —
--                only renamed.
--   Blocking     Reads and writes to this one table for those milliseconds.
--                `lock_timeout` caps the wait at three seconds, so a long-running
--                transaction holding a conflicting lock aborts this migration
--                cleanly instead of queueing ahead of every new query.
--   Write cost   One more index maintained on insert (the dedupe unique), paid on
--                notification writes, which are per breach and per fired workflow.
--   Data loss    None. Purely additive plus a rename; no column is dropped and no
--                value changes meaning.
--   Rollback     `down.sql` beside this file. Structurally exact, and lossless
--                exactly while no `workflow_notify` / `workflow_broken` row
--                exists — see that file.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Guard. The rename is only safe if this really is TAR-270's table: a
-- half-applied earlier attempt, or a hand-made `notifications` table, would
-- otherwise fail somewhere in the middle of this file with a bare Postgres error
-- naming one object.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'sla_alerts' AND c.relkind = 'r'
    ) THEN
        RAISE EXCEPTION 'TAR-394 refuses to run: public.sla_alerts does not exist'
            USING HINT =
                'This migration renames the table 20260813130000_sla_pause_accounting_and_alerts '
                'created. If it is already called notifications, this migration has been applied '
                'and _prisma_migrations disagrees — reconcile the history rather than editing '
                'this file.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'notifications'
    ) THEN
        RAISE EXCEPTION 'TAR-394 refuses to run: public.notifications already exists'
            USING HINT =
                'Something other than this migration created it. Drop or rename that object '
                'deliberately, with a look at what is in it first.';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. The rename, and every object named after the old table.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "public"."sla_alerts" RENAME TO "notifications";

ALTER INDEX "public"."sla_alerts_pkey" RENAME TO "notifications_pkey";
ALTER INDEX "public"."sla_alerts_tenant_id_sla_timer_id_recipient_user_id_key"
    RENAME TO "notifications_tenant_id_sla_timer_id_recipient_user_id_key";
ALTER INDEX "public"."sla_alerts_tenant_id_recipient_user_id_created_at_id_idx"
    RENAME TO "notifications_tenant_id_recipient_user_id_created_at_id_idx";
ALTER INDEX "public"."sla_alerts_tenant_id_ticket_id_idx"
    RENAME TO "notifications_tenant_id_ticket_id_idx";

ALTER TABLE "public"."notifications"
    RENAME CONSTRAINT "sla_alerts_tenant_id_fkey" TO "notifications_tenant_id_fkey";
ALTER TABLE "public"."notifications"
    RENAME CONSTRAINT "sla_alerts_tenant_id_sla_timer_id_fkey" TO "notifications_tenant_id_sla_timer_id_fkey";
ALTER TABLE "public"."notifications"
    RENAME CONSTRAINT "sla_alerts_tenant_id_ticket_id_fkey" TO "notifications_tenant_id_ticket_id_fkey";
ALTER TABLE "public"."notifications"
    RENAME CONSTRAINT "sla_alerts_tenant_id_recipient_user_id_fkey" TO "notifications_tenant_id_recipient_user_id_fkey";

-- ---------------------------------------------------------------------------
-- 2. The type, the payload and the workflow dedupe key.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('sla_breach', 'workflow_notify', 'workflow_broken');

-- AlterTable
ALTER TABLE "public"."notifications"
    ADD COLUMN "type" "notification_type" NOT NULL DEFAULT 'sla_breach',
    ADD COLUMN "data" JSONB,
    ADD COLUMN "dedupe_key" TEXT;

-- ---------------------------------------------------------------------------
-- 3. The three SLA columns become nullable, behind one invariant.
--
-- 0009 specifies `CHECK ((type = 'sla_breach') = (sla_timer_id IS NOT NULL))`.
-- This is that constraint widened to all three columns it made nullable, in both
-- directions: a breach row carries the timer, its kind and the deadline it missed,
-- and a workflow row carries none of them. The narrower version would admit a
-- `workflow_notify` row with a `due_at`, which the console would render as a
-- missed deadline that never existed.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "public"."notifications"
    ALTER COLUMN "sla_timer_id" DROP NOT NULL,
    ALTER COLUMN "kind" DROP NOT NULL,
    ALTER COLUMN "due_at" DROP NOT NULL;

ALTER TABLE "public"."notifications"
    ADD CONSTRAINT "notifications_sla_breach_columns" CHECK (
        CASE
            WHEN "type" = 'sla_breach'
                THEN num_nonnulls("sla_timer_id", "kind", "due_at") = 3
            ELSE num_nulls("sla_timer_id", "kind", "due_at") = 3
        END
    );

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_recipient_user_id_dedupe_key_key"
    ON "public"."notifications" ("tenant_id", "recipient_user_id", "dedupe_key");
