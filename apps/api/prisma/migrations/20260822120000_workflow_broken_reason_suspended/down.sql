-- Reverses 20260822120000_workflow_broken_reason_suspended.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- ⚠️ PostgreSQL cannot drop an enum label, and this script does not pretend to
-- ---------------------------------------------------------------------------
--
-- There is no `ALTER TYPE ... DROP VALUE`. The only ways to remove
-- `reference_suspended` are to recreate the type — dropping and recreating
-- `workflows.broken_reason`, which takes ACCESS EXCLUSIVE on `workflows` — or to
-- delete the row from `pg_enum` by hand, which corrupts any row still carrying
-- the label. Both are worse than leaving an inert label behind.
--
-- **So this script clears the rows that carry it and leaves the label**, which
-- is the rollback the older version actually needs:
--
--   * The version being rolled back to never writes `reference_suspended`, but
--     it does read `broken_reason` — through Prisma, whose generated enum would
--     not contain the label. A row still carrying it would fail to deserialise
--     on the read path rather than render as an unknown reason, so the rows must
--     go even though the label may stay.
--   * `reference_removed` is what the older code would have written for the same
--     workflow, so the update re-states the fact rather than discarding it: the
--     workflow stays disarmed and stays reported as broken. `is_active` is not
--     touched, which keeps `workflows_broken_is_inactive` satisfied throughout.
--   * Re-applying the forward migration finds the label already present and is
--     fine with it: that statement is `ADD VALUE IF NOT EXISTS`, precisely
--     because this script leaves the label behind.
--
-- Idempotent: a second run matches no rows and the notice still fires.

SET LOCAL lock_timeout = '3s';

UPDATE "workflows"
   SET "broken_reason" = 'reference_removed'
 WHERE "broken_reason" = 'reference_suspended';

DO $$
BEGIN
    RAISE NOTICE
        'workflow_broken_reason.reference_suspended is left in place: PostgreSQL '
        'has no ALTER TYPE ... DROP VALUE, and an unused label is inert. The rows '
        'that carried it have been restated as reference_removed, which is what '
        'the previous version would have written.';
END
$$;
