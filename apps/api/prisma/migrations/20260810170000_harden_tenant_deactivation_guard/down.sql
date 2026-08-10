-- Reverses 20260810170000_harden_tenant_deactivation_guard.
--
-- Restores the definition `20260810150000_tenant_deactivation_guard` shipped,
-- rather than dropping the function: the application calls it on every tenant
-- statement, so dropping it here would take the product down for a change that
-- only hardened how the function resolves names and how it reports a malformed
-- id. Roll back to the previous behaviour, not to nothing.
--
-- What comes back with it: an unqualified `search_path` inside the body, and
-- `22P02` instead of `TN001` for an id that is not a uuid. Neither exposes data
-- — the gate still admits only `active` tenants — but the call site in
-- `tenant-scope.extension.ts` qualifies the function as `public.…`, which keeps
-- working either way.
--
-- No data is touched. The function reads `tenants` and writes nothing.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit.

BEGIN;

CREATE OR REPLACE FUNCTION "public"."assert_tenant_active"(tenant_id text)
    RETURNS text
    LANGUAGE plpgsql
    STABLE
AS $$
DECLARE
    current_status "public"."tenant_status";
BEGIN
    IF tenant_id IS NULL OR tenant_id = '' THEN
        RAISE EXCEPTION 'TENANT_NOT_ACTIVE: no tenant id was supplied'
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
    'tenant never sets the GUC that TAR-48''s RLS policies read.';

COMMIT;
