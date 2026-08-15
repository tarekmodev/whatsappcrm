-- Reverses 20260815120000_tenant_lifecycle_status_vocabulary.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- The rename reverses. The three added labels do not, and must not.
-- ---------------------------------------------------------------------------
--
-- PostgreSQL has no `ALTER TYPE ... DROP VALUE`. Removing an enum label means
-- creating a replacement type, rewriting every dependent column, re-pointing
-- defaults and dropping the old type — an ACCESS EXCLUSIVE lock on `tenants`
-- for the duration, to undo an addition that costs nothing to leave in place.
--
-- It would also destroy state: a tenant already moved to `trialing`, `past_due`
-- or `deleted` has no other legal value to fall back to, so the rewrite would
-- either fail on those rows or silently report a suspended tenant as active.
-- That is a data-retention incident dressed as a rollback.
--
-- An unused enum label is inert. Nothing filters on it, no index is affected,
-- and the catalog row is a few bytes. Rolling the application back is complete
-- on its own: code that predates TAR-403 never writes the three labels.
--
-- This is the same answer, for the same reasons, that
-- `20260811170000_conversation_status_closed/down.sql` gives.
--
-- ---------------------------------------------------------------------------
-- Why the rename *is* reversed
-- ---------------------------------------------------------------------------
--
-- `created` is a rename of a label that already existed, so putting `pending`
-- back is one catalog update and loses nothing — the rows carrying it are the
-- same rows, under the name the code being rolled back to expects. Without it,
-- `PROVISIONED_TENANT_STATUSES` at the previous version rejects every
-- pre-provisioning tenant it reads.
--
-- Guarded for the same reason as the forward direction: `RENAME VALUE` has no
-- `IF EXISTS` form, and this file has to be safe on a database that never
-- reached this migration.
--
-- ---------------------------------------------------------------------------
-- Ordering
-- ---------------------------------------------------------------------------
--
-- Run this **after** `20260815130000`'s down.sql, never before. That migration's
-- constraints and backfilled rows reference `deleted` and `trialing`; this one
-- leaves those labels in place, so the order is not load-bearing for the labels
-- themselves — but `db-rollback.mjs` applies down migrations newest-first
-- anyway, and nothing here should encourage doing it by hand in the other
-- direction.

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'tenant_status' AND e.enumlabel = 'created'
    ) THEN
        ALTER TYPE "public"."tenant_status" RENAME VALUE 'created' TO 'pending';
        RAISE NOTICE 'tenant_status: renamed created back to pending';
    ELSE
        RAISE NOTICE 'tenant_status: no created label, nothing to rename back';
    END IF;
END
$$;

COMMENT ON TYPE "public"."tenant_status" IS NULL;
