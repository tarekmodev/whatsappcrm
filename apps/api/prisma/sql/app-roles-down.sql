-- Reverses app-roles.sql (TAR-48).
--
--   pnpm db:roles:down                                   # local Docker stack
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f apps/api/prisma/sql/app-roles-down.sql          # any other environment
--
-- ⚠️ Removes the roles the application connects as. Any live connection using
-- one keeps working until it disconnects; the next connection attempt fails to
-- authenticate. Do not run this against an environment that is serving traffic.
--
-- No data is touched: roles own no objects here — migrations run as the
-- database owner, which this script leaves alone.
--
-- `DROP OWNED BY` is what makes `DROP ROLE` succeed. A role cannot be dropped
-- while any privilege still references it, and every `GRANT` in app-roles.sql
-- is such a reference. `DROP OWNED BY` removes those grants and the default
-- privileges — and, because these roles own nothing, nothing else. It is
-- database-scoped, so a cluster where the roles were granted privileges in a
-- second database needs this run there too before the `DROP ROLE` succeeds.
--
-- The `system_unrestricted` policies go first and explicitly: dropping a role
-- referenced by a policy's `TO` clause fails, and the message names the policy
-- rather than the table, which is a needlessly puzzling way to find out.
--
-- The `EXECUTE` grant on the gate functions goes back to `PUBLIC` for a
-- different reason. `DROP OWNED BY` removes what was granted *to* these roles,
-- but not the `REVOKE ... FROM PUBLIC` that app-roles.sql pairs it with — so
-- without this the function would be left executable by nobody but the owner,
-- which is not the state this file claims to restore.
--
-- Both gates are listed because both exist for the length of ADR 0009's
-- expand → migrate → contract rename; whichever is absent is skipped.
--
-- Nothing is done about the column-level `GRANT UPDATE ("notified_at")` on
-- `lifecycle_audit_log`: that one was granted *to* `whatsappcrm_system` and has
-- no `REVOKE ... FROM PUBLIC` half, so `DROP OWNED BY` below takes it with the
-- rest.

\set ON_ERROR_STOP on

\echo '== app roles: restoring the default grant on the tenant gate functions =='

DO $$
DECLARE
    gate text;
BEGIN
    FOREACH gate IN ARRAY ARRAY['assert_tenant_active', 'assert_tenant_serviceable'] LOOP
        IF EXISTS (
            SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = gate
        ) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION "public".%I(text) TO PUBLIC', gate);
        END IF;
    END LOOP;
END
$$;

\echo '== app roles: dropping system_unrestricted policies =='

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_policy p ON p.polrelid = c.oid
        WHERE n.nspname = 'public'
          AND p.polname = 'system_unrestricted'
        ORDER BY c.relname
    LOOP
        EXECUTE format('DROP POLICY "system_unrestricted" ON "public".%I', t.relname);
    END LOOP;
END
$$;

\echo '== app roles: dropping roles =='

DO $$
DECLARE
    role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['whatsappcrm_app', 'whatsappcrm_system'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('DROP OWNED BY %I', role_name);
            EXECUTE format('DROP ROLE %I', role_name);
            RAISE NOTICE 'dropped role %', role_name;
        END IF;
    END LOOP;
END
$$;

\echo '== app roles: done =='
