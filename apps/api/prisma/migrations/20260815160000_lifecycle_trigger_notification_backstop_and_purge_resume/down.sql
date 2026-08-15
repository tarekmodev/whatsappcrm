-- Reverses 20260815160000_lifecycle_trigger_notification_backstop_and_purge_resume.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE RUNNING IT: what it destroys
-- ---------------------------------------------------------------------------
--
-- Cheaper than TAR-403's reversal — no table is dropped and no tenant loses a
-- timer it is running — but three facts go, and none can be reconstructed:
--
--   * **`trigger` on every recorded transition.** Whether a suspension was a
--     timer, a billing event or a person is the fact the column exists to hold,
--     and after this it is gone for rows already written. `actor_type` survives
--     and answers a narrower question: who, not what kind of event.
--   * **`notified_at` on every recorded transition.** Which transitions had
--     their tenant-admin email sent. Rolling forward again stamps every existing
--     row as settled, so any genuinely unsent notification from the window in
--     between is never re-enqueued.
--   * **`purge_started_at`.** A tenant mid-purge loses its resume point, and the
--     next sweep on the restored code restarts it from the first batch.
--
-- Take a verified backup first. On a database where TAR-404's engine has
-- recorded transitions, the forward fix is a new migration rather than this one.
--
-- ---------------------------------------------------------------------------
-- What it deliberately does not do
-- ---------------------------------------------------------------------------
--
-- It does not touch `app-roles.sql`'s column-level `GRANT UPDATE
-- ("notified_at")`. Dropping the column drops the grant with it — PostgreSQL
-- removes column privileges along with the column — so there is nothing to
-- revoke here, and re-running `pnpm db:roles` after a rollback is a no-op that
-- skips the grant with a notice rather than failing.
--
-- ---------------------------------------------------------------------------
-- Order
-- ---------------------------------------------------------------------------
--
-- The trigger function goes back to its unconditional form **before** the column
-- it excepts is dropped, so no window exists in which the function references a
-- column that is gone. Its body names `notified_at` only inside the version
-- being replaced, so the replacement is safe in either order — the ordering is
-- for the reader.
--
-- The index goes with its column and needs no statement of its own; it is
-- dropped explicitly anyway so a partial run leaves nothing behind.

SET LOCAL lock_timeout = '3s';

-- The trigger function as `20260815130000` left it: every UPDATE refused,
-- unconditionally, including the owner's.
CREATE OR REPLACE FUNCTION "public"."lifecycle_audit_log_forbid_update"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION 'lifecycle_audit_log is append-only: row % cannot be updated', OLD."id"
        USING ERRCODE = 'TN002',
              HINT = 'Record the correction as a new transition instead of editing the old one.';
END;
$$;

COMMENT ON FUNCTION "public"."lifecycle_audit_log_forbid_update"() IS
    'TAR-403. Raises TN002 on any UPDATE of lifecycle_audit_log, including by the table owner. '
    'DELETE is intentionally not blocked: it is reachable only by the ON DELETE CASCADE from '
    'tenants, which a row trigger cannot tell apart from a hand-written statement.';

DROP INDEX IF EXISTS "public"."lifecycle_audit_log_notified_at_pending_idx";

ALTER TABLE "public"."lifecycle_audit_log"
    DROP COLUMN IF EXISTS "notified_at",
    DROP COLUMN IF EXISTS "trigger";

-- After the column that uses it, or the type is still in use and the DROP fails.
DROP TYPE IF EXISTS "public"."lifecycle_trigger";

ALTER TABLE "public"."tenants"
    DROP COLUMN IF EXISTS "purge_started_at";
