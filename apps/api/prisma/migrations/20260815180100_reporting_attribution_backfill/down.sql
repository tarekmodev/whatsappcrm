-- Reverses 20260815180100_reporting_attribution_backfill.
--
-- Clears both attribution columns, which is the state before that migration ran.
--
-- ⚠️ **Read this before running it.** The up migration only ever wrote a column
-- that was NULL, so it cannot be undone selectively: this file cannot tell an
-- attribution the backfill reconstructed from one the live writers recorded
-- afterwards, and it clears both. On a system that has been serving traffic
-- since the deploy, that discards real data to undo a reconstruction.
--
-- Rolling back the backfill alone is almost never what is wanted. The two cases
-- where it is:
--
--   * the backfill attributed work to the wrong people — a wrong predicate, a
--     data shape it did not anticipate — and the honest state is "unattributed"
--     until a corrected forward migration runs;
--   * it is being replayed immediately, before the application that writes these
--     columns has been deployed, so nothing but the backfill has written them.
--
-- Otherwise leave the data and roll back the code. Both columns are read by
-- `ReportingModule` alone, and a column nothing reads costs a deploy nothing.
--
-- The RLS toggle is here for the same reason the up migration has one: `tickets`
-- is `FORCE ROW LEVEL SECURITY` and this runs as the owner, so without it the
-- UPDATE matches zero rows and reports success.
--
-- The explicit transaction is here because, unlike the up migration, this file is
-- applied by hand through `psql`, which is in autocommit.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
    cleared bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."tickets" NO FORCE ROW LEVEL SECURITY';

    UPDATE "public"."tickets"
       SET "first_response_user_id" = NULL,
           "resolved_by_user_id" = NULL
     WHERE "first_response_user_id" IS NOT NULL
        OR "resolved_by_user_id" IS NOT NULL;

    GET DIAGNOSTICS cleared = ROW_COUNT;

    EXECUTE 'ALTER TABLE "public"."tickets" FORCE ROW LEVEL SECURITY';

    RAISE NOTICE 'TAR-30: cleared attribution on % ticket(s)', cleared;
END
$$;

COMMIT;
