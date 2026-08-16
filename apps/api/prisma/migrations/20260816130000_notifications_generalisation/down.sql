-- Reverses 20260816130000_notifications_generalisation.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- Puts back exactly the shape 20260813130000_sla_pause_accounting_and_alerts
-- left: a table called `sla_alerts`, its objects named after it, no `type`, no
-- `data`, no `dedupe_key`, and `sla_timer_id`, `kind` and `due_at` `NOT NULL`
-- again. Statements run in the reverse order of the up migration, so nothing here
-- depends on something this file has already removed.
--
-- ---------------------------------------------------------------------------
-- When it is safe, stated as a condition rather than a hope
-- ---------------------------------------------------------------------------
--
-- Restoring the three `NOT NULL`s succeeds **precisely as long as no
-- `workflow_notify` or `workflow_broken` row exists** — i.e. as long as this is a
-- rollback of this release rather than an attempt to un-ship a feature that has
-- been running. Those rows have a null `sla_timer_id` by construction, and there
-- is no value to invent for them: a made-up timer id would attach a workflow
-- notification to a deadline nobody missed.
--
-- So this file **refuses** rather than guessing, and names the count. The forward
-- fix from that point is a new migration that decides what happens to those rows
-- with somebody's agreement, not a better `down.sql`.
--
-- The `type` column going is what makes those rows unrecoverable if they are
-- deleted first, which is why this file does not delete them.
--
-- ---------------------------------------------------------------------------
-- What it gives up in the meantime
-- ---------------------------------------------------------------------------
--
-- Between this file and a re-apply there is no `notifications_sla_breach_columns`
-- and no dedupe unique — but there is also no writer for either, because the code
-- being rolled back to is TAR-26's, which only ever writes breaches.
--
-- No `pnpm db:roles` re-run is needed in either direction: policies, grants and
-- the `system_unrestricted` policy are attached to the table's OID rather than its
-- name, and `verify-tenant-isolation.sql` names the table by hand — so run the
-- matching revision of that file, not this one against a newer checkout.
--
-- Locks and duration mirror the up migration: ACCESS EXCLUSIVE on the one table
-- for a few milliseconds. The `ALTER COLUMN ... SET NOT NULL`s each scan it, which
-- is free at the sizes any current environment holds.
--
-- The explicit transaction is here because, unlike the up migration, this file is
-- applied by hand through `psql`, which is in autocommit. It is the same
-- `BEGIN;`/`COMMIT;` pair ten of the other `down.sql` files carry, so it is the
-- convention rather than a choice made here — and `db:check-migrations` requires
-- exactly this shape: one outermost pair, nothing after the `COMMIT`.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- Refuse rather than guess. See the header.
DO $$
DECLARE
    workflow_rows bigint;
BEGIN
    -- The migration owner is not exempt from FORCE ROW LEVEL SECURITY and no
    -- `app.tenant_id` is set here, so a plain count reads zero on a full table —
    -- the guard would wave through exactly the case it exists to stop. Counting
    -- with the policy suspended is the only reading that means anything. Safe
    -- inline: this transaction already holds ACCESS EXCLUSIVE on the table by the
    -- time it matters, no other session can read it while FORCE is off, and an
    -- abort — including the RAISE below — rolls the toggle back with everything
    -- else. Same idiom as the guards in TAR-285's and TAR-270's migrations.
    EXECUTE 'ALTER TABLE "public"."notifications" NO FORCE ROW LEVEL SECURITY';

    SELECT count(*) INTO workflow_rows
    FROM "public"."notifications"
    WHERE "type" <> 'sla_breach';

    EXECUTE 'ALTER TABLE "public"."notifications" FORCE ROW LEVEL SECURITY';

    IF workflow_rows > 0 THEN
        RAISE EXCEPTION
            'TAR-394 rollback refuses to run: % workflow notification(s) exist',
            workflow_rows
            USING HINT =
                'Dropping the type column would leave them indistinguishable from SLA breaches, '
                'and restoring sla_timer_id NOT NULL cannot succeed with them present. List them '
                'with SELECT id, tenant_id, type FROM notifications WHERE type <> ''sla_breach'' — '
                'then decide deliberately what happens to them in a forward migration. Do not '
                'delete them to make this pass.';
    END IF;
END
$$;

-- 3. The three SLA columns are mandatory again, and the invariant goes with them.
ALTER TABLE "public"."notifications"
    DROP CONSTRAINT IF EXISTS "notifications_sla_breach_columns";

ALTER TABLE "public"."notifications"
    ALTER COLUMN "sla_timer_id" SET NOT NULL,
    ALTER COLUMN "kind" SET NOT NULL,
    ALTER COLUMN "due_at" SET NOT NULL;

-- 2. The type, the payload and the dedupe key.
DROP INDEX IF EXISTS "public"."notifications_tenant_id_recipient_user_id_dedupe_key_key";

ALTER TABLE "public"."notifications"
    DROP COLUMN IF EXISTS "dedupe_key",
    DROP COLUMN IF EXISTS "data",
    DROP COLUMN IF EXISTS "type";

DROP TYPE IF EXISTS "notification_type";

-- 1. Back to `sla_alerts`, with every object named after it again.
ALTER TABLE "public"."notifications"
    RENAME CONSTRAINT "notifications_tenant_id_recipient_user_id_fkey" TO "sla_alerts_tenant_id_recipient_user_id_fkey";
ALTER TABLE "public"."notifications"
    RENAME CONSTRAINT "notifications_tenant_id_ticket_id_fkey" TO "sla_alerts_tenant_id_ticket_id_fkey";
ALTER TABLE "public"."notifications"
    RENAME CONSTRAINT "notifications_tenant_id_sla_timer_id_fkey" TO "sla_alerts_tenant_id_sla_timer_id_fkey";
ALTER TABLE "public"."notifications"
    RENAME CONSTRAINT "notifications_tenant_id_fkey" TO "sla_alerts_tenant_id_fkey";

ALTER INDEX "public"."notifications_tenant_id_ticket_id_idx"
    RENAME TO "sla_alerts_tenant_id_ticket_id_idx";
ALTER INDEX "public"."notifications_tenant_id_recipient_user_id_created_at_id_idx"
    RENAME TO "sla_alerts_tenant_id_recipient_user_id_created_at_id_idx";
ALTER INDEX "public"."notifications_tenant_id_sla_timer_id_recipient_user_id_key"
    RENAME TO "sla_alerts_tenant_id_sla_timer_id_recipient_user_id_key";
ALTER INDEX "public"."notifications_pkey" RENAME TO "sla_alerts_pkey";

ALTER TABLE "public"."notifications" RENAME TO "sla_alerts";

COMMIT;
