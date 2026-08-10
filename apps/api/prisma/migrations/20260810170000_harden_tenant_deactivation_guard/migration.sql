-- Hardening for TAR-51's deactivation gate, from the database review of
-- `7ab4c7c`. Two changes to `assert_tenant_active`, neither of which alters what
-- it admits: an `active` tenant passes and everything else is refused, exactly
-- as before.
--
-- Forward-only, as a replacement rather than an edit to
-- `20260810150000_tenant_deactivation_guard`: that migration has been applied to
-- `main` and to CI, and editing an applied migration is how a fleet at mixed
-- versions diverges. `CREATE OR REPLACE` makes this safe to apply to a database
-- at either version and safe to re-run.
--
-- ---------------------------------------------------------------------------
-- 1. The function's own name resolution is pinned
-- ---------------------------------------------------------------------------
--
-- `SET search_path = pg_catalog, public` binds every unqualified name inside the
-- body — the `<>` operator on `tenant_status`, the `::uuid` cast, the regex
-- operator — to the schemas named here, whatever the calling connection's
-- `search_path` happens to be. Without it, a role or connection string that puts
-- another schema first could resolve one of those to something else; with it,
-- the gate evaluates identically on every connection.
--
-- The call site is qualified to match (`public.assert_tenant_active(...)` in
-- `tenant-scope.extension.ts`). That one is not a hijacking risk but an
-- availability one: an unqualified call on a connection whose `search_path` does
-- not include `public` fails with "function does not exist", and since every
-- tenant statement makes that call, the failure is a full outage. Fail-closed,
-- but avoidable — and not reproducible on the Compose stack, whose default
-- `"$user", public` hides it.
--
-- ---------------------------------------------------------------------------
-- 2. A malformed tenant id is refused, not cast
-- ---------------------------------------------------------------------------
--
-- `tenant_id::uuid` raises `22P02 invalid_text_representation` on anything that
-- is not a uuid, which the application does not recognise as this function's
-- refusal — so a caller that passed a malformed id got a 500 rather than the 403
-- it had earned. No isolation consequence: the cast raises before `set_config`,
-- so the GUC is unset and the policies match nothing either way. It is error
-- classification, and it is worth fixing here because `TenantContextService`
-- accepts any string as a tenant id and TAR-35 will be what calls it.
--
-- Checked with a pattern rather than caught with an exception block on purpose:
-- a plpgsql `EXCEPTION` clause opens a subtransaction on every call, and this
-- function is on the path of every tenant statement in the product. The pattern
-- is the canonical uuid form, which is the only form anything in this system
-- issues — Prisma's `uuid(7)` writes it and reads it back that way.
--
-- ---------------------------------------------------------------------------
-- The grant this function depends on
-- ---------------------------------------------------------------------------
--
-- It reads `tenants` as the **calling** role, so `whatsappcrm_app` must hold
-- `SELECT` on that table. It does, deliberately: `tenants` carries no RLS policy
-- (TAR-48 — provisioning and host→tenant resolution both read it before any
-- tenant is in scope) and `prisma/sql/app-roles.sql` grants the app role an
-- unfiltered `SELECT` on it, recording that as known residual exposure.
--
-- That dependency is load-bearing and now stated, because TAR-49 flagged the
-- idea of narrowing that grant. If it is ever narrowed, this function must
-- become `SECURITY DEFINER` in the same change — the `SET search_path` above is
-- already the half of that pattern which makes it safe. It is deliberately not
-- `SECURITY DEFINER` today: on a managed Postgres the owner is usually a
-- superuser, and running as one is an escalation surface worth introducing only
-- when something needs it.
--
-- `EXECUTE` is managed by `prisma/sql/app-roles.sql`, which revokes the default
-- `PUBLIC` grant and names the two roles. Re-run `pnpm db:roles` after applying
-- this migration; until it is re-run the function keeps working on the old
-- default, so the ordering is not load-bearing.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Replaces one function; reads and writes no rows.
--   Locks        None on any table.
--   Behaviour    Unchanged for every id the application actually issues. A
--                malformed id changes from SQLSTATE 22P02 to TN001 — both
--                refusals, differing only in how the application reports them.
--   Re-runnable  `CREATE OR REPLACE`, so applying it twice is a no-op.
--   Rollback     `down.sql` beside this file restores the previous definition.

CREATE OR REPLACE FUNCTION "public"."assert_tenant_active"(tenant_id text)
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $$
DECLARE
    -- Not named `tenant_status`: that is the enum's own name, and a variable
    -- that shadows a type reads as a mistake even where it resolves.
    current_status "public"."tenant_status";
BEGIN
    IF tenant_id IS NULL OR tenant_id = '' THEN
        RAISE EXCEPTION 'TENANT_NOT_ACTIVE: no tenant id was supplied'
            USING ERRCODE = 'TN001';
    END IF;

    IF tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        -- Refused as this function's own error rather than left to the cast, so
        -- the application reports it as the refusal it is.
        RAISE EXCEPTION 'TENANT_NOT_ACTIVE: tenant id % is not a uuid', tenant_id
            USING ERRCODE = 'TN001';
    END IF;

    SELECT t."status" INTO current_status
    FROM "public"."tenants" t
    WHERE t."id" = tenant_id::uuid;

    IF NOT FOUND THEN
        -- A tenant that has been hard-deleted, or an id from a session issued
        -- against another database. Same answer as a deactivated one: the
        -- caller learns nothing about which it was.
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
