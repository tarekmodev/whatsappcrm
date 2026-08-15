-- Reverses 20260815130000_tenant_lifecycle_retention_audit_and_limits.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE RUNNING IT: what it destroys
-- ---------------------------------------------------------------------------
--
-- This is a reversal, not a safe one. Three kinds of data go, and none of them
-- can be reconstructed from anything left behind:
--
--   * **`lifecycle_audit_log` in its entirety.** Every recorded transition,
--     including the reason and actor for every suspension and cancellation. The
--     table exists precisely because that record is supposed to be permanent.
--   * **`tenant_plan_limits` in its entirety.** Every tenant's effective seat and
--     conversation cap. TAR-405's enforcement reads it; a tenant whose caps were
--     raised by hand loses that.
--   * **The four retention timers on `tenants`.** A tenant mid-way through a
--     grace period, or scheduled for purge, loses its scheduled instant — so the
--     sweeper on the previous version neither purges it nor knows it was due.
--
-- Take a verified backup first. On anything but a database where TAR-404 has
-- never run a transition, the forward fix is a new migration rather than this.
--
-- ---------------------------------------------------------------------------
-- What it deliberately does not do
-- ---------------------------------------------------------------------------
--
-- It does not touch `tenants.status`. A tenant already moved to `trialing`,
-- `past_due` or `deleted` keeps that status, because there is no other value
-- that is true of it — and the restored `assert_tenant_active` below refuses
-- all three. **A trialing tenant is locked out the moment this runs.** That is
-- the honest consequence of rolling back to a gate that predates the state, and
-- it is why this file names it rather than papering over it with an UPDATE that
-- would lie about where each tenant stands.
--
-- The `tenant_status` labels themselves belong to `20260815120000`, whose
-- down.sql explains why they stay.
--
-- ---------------------------------------------------------------------------
-- Order
-- ---------------------------------------------------------------------------
--
-- Tables before the `tenants` columns they reference; the trigger and its
-- function before the table they hang off, so a partial run leaves nothing
-- orphaned. Policies and indexes go with their tables and need no statement of
-- their own.

SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS "lifecycle_audit_log_append_only" ON "public"."lifecycle_audit_log";
DROP FUNCTION IF EXISTS "public"."lifecycle_audit_log_forbid_update"();

DROP TABLE IF EXISTS "public"."lifecycle_audit_log";
DROP TABLE IF EXISTS "public"."tenant_plan_limits";

DROP INDEX IF EXISTS "public"."tenants_grace_period_ends_at_idx";
DROP INDEX IF EXISTS "public"."tenants_purge_at_idx";

ALTER TABLE "public"."tenants"
    DROP CONSTRAINT IF EXISTS "tenants_deleted_at_matches_status";

ALTER TABLE "public"."tenants"
    DROP COLUMN IF EXISTS "cancelled_at",
    DROP COLUMN IF EXISTS "grace_period_ends_at",
    DROP COLUMN IF EXISTS "purge_at",
    DROP COLUMN IF EXISTS "deleted_at";

-- The gate as `20260810170000_harden_tenant_deactivation_guard` left it:
-- `active` passes, everything else is refused.
CREATE OR REPLACE FUNCTION "public"."assert_tenant_active"(tenant_id text)
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $$
DECLARE
    current_status "public"."tenant_status";
BEGIN
    IF tenant_id IS NULL OR tenant_id = '' THEN
        RAISE EXCEPTION 'TENANT_NOT_ACTIVE: no tenant id was supplied'
            USING ERRCODE = 'TN001';
    END IF;

    IF tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'TENANT_NOT_ACTIVE: tenant id % is not a uuid', tenant_id
            USING ERRCODE = 'TN001';
    END IF;

    SELECT t."status" INTO current_status
    FROM "public"."tenants" t
    WHERE t."id" = tenant_id::uuid;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'TENANT_NOT_ACTIVE: tenant % does not exist', tenant_id
            USING ERRCODE = 'TN001';
    END IF;

    IF current_status <> 'active' THEN
        RAISE EXCEPTION 'TENANT_NOT_ACTIVE: tenant % is %', tenant_id, current_status
            USING ERRCODE = 'TN001';
    END IF;

    RETURN tenant_id;
END;
$$;

COMMENT ON FUNCTION "public"."assert_tenant_active"(text) IS
    'TAR-51. Returns the tenant id when that tenant is active, and raises TN001 otherwise. '
    'Called by TenantPrisma around every set_config(''app.tenant_id'', ...), so a deactivated '
    'tenant never sets the GUC that TAR-48''s RLS policies read. Reads tenants as the calling '
    'role, so whatsappcrm_app''s SELECT on that table is load-bearing.';
