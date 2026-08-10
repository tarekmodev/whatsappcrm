-- Tenant deactivation (TAR-51).
--
-- Deactivation retains a tenant's data and takes its access away. The retention
-- half needs no schema: `tenants.status` and `tenants.suspended_at` already
-- exist (TAR-47) and deactivation only writes them, so every row the tenant
-- ever wrote stays exactly where it was. This migration is the access half.
--
-- ---------------------------------------------------------------------------
-- Where the check goes, and why here
-- ---------------------------------------------------------------------------
--
-- Every statement `TenantPrisma` sends is preceded, in the same transaction, by
--
--   SELECT set_config('app.tenant_id', $1, true);
--
-- which is the one gate all tenant data passes through: TAR-48's
-- `tenant_isolation` policies read that GUC, and with no GUC set they match no
-- rows. So the cheapest correct place to enforce "this tenant may not reach its
-- data" is between the tenant id and the GUC:
--
--   SELECT set_config('app.tenant_id', assert_tenant_active($1), true);
--
-- `assert_tenant_active` returns the id it was given when the tenant is
-- `active`, and raises otherwise. Postgres evaluates the inner call first, so a
-- deactivated tenant never reaches `set_config` and the statement the extension
-- batched behind it never runs.
--
-- The properties that make this the mechanism rather than a convenience:
--
--   * **It covers everything, including raw SQL.** The GUC is set for every
--     model query, every `$queryRaw`/`$executeRaw`, and once per
--     `$tenantTransaction`. There is no `TenantPrisma` path that reaches a row
--     without passing through here.
--   * **It takes effect on the next statement.** The status is read inside the
--     transaction that is about to run, not from a cache with a TTL, so a
--     deactivation is in force the instant it commits. Access control with an
--     eventual-consistency window is not access control.
--   * **It fails closed twice.** If the raise were ever swallowed, `set_config`
--     has not run, the GUC is unset, and the policy predicate evaluates to NULL
--     — zero rows rather than every row.
--   * **It is per tenant.** The predicate reads the one row identified by the
--     GUC value, so deactivating one tenant cannot affect another. No other
--     tenant's statements change shape or cost.
--
-- What it deliberately does not touch: `SystemPrisma`, which never sets the
-- GUC. Support tooling, billing, reactivation and the platform-admin surface
-- must keep working on a deactivated tenant — that is the difference between
-- revoking access and losing the data.
--
-- ---------------------------------------------------------------------------
-- The predicate: `status = 'active'`
-- ---------------------------------------------------------------------------
--
-- `pending` is a tenant whose provisioning has not finished, `suspended` is a
-- deactivated one, `cancelled` is a closed one. Only `active` is a tenant that
-- is operating, so only `active` gets its data — and a status the enum grows
-- later is refused until someone decides otherwise, rather than admitted by
-- default.
--
-- Known conflict, flagged for TAR-36 rather than resolved here:
-- `TENANT_STATUS_EFFECTS` in `packages/contracts/src/tenant.ts` says
-- `suspended` keeps `apiAccess: true`. That table describes the *billing*
-- lifecycle (`trialing`/`past_due`/`deleted`), a vocabulary the `tenant_status`
-- column does not have — `admin.ts` records the drift and gives TAR-36 the job
-- of reconciling the two. Under the column as it exists today `suspended` has
-- one meaning, and TAR-19's third acceptance criterion and the `suspended_at`
-- comment in `schema.prisma` both give it: deactivated, data retained, access
-- revoked. When TAR-36 introduces a separate dunning state, the predicate to
-- change is in this function and nowhere else.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Creates one function; reads and writes no rows.
--   Locks        None on any table. `CREATE OR REPLACE FUNCTION` takes a lock
--                on the function itself, which nothing else holds.
--   Cost         One primary-key lookup on `tenants` per statement, inside the
--                round trip that was already being made. No extra round trip.
--   Additive     The function is new and nothing calls it until the application
--                that does is deployed, so this migration is safe to apply
--                ahead of the release — and must be, since the new application
--                fails closed without it.
--   Re-runnable  `CREATE OR REPLACE`, so applying it twice is a no-op.
--   Rollback     `down.sql` beside this file. Drops the function, which the
--                application at this version calls on every query — roll the
--                application back first.

-- Raised for every refusal. `TN` is not a class PostgreSQL uses, so this cannot
-- collide with a real database error, and the application matches on it to tell
-- "this tenant is deactivated" (a 403 the operator caused) from "the database
-- is unhappy" (a fault). `TENANT_NOT_ACTIVE` is repeated in the message text
-- because a driver that drops the SQLSTATE still carries the message; both are
-- read on the application side, so either alone is enough.
CREATE OR REPLACE FUNCTION "public"."assert_tenant_active"(tenant_id text)
    RETURNS text
    LANGUAGE plpgsql
    STABLE
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
    'tenant never sets the GUC that TAR-48''s RLS policies read.';
