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

\set ON_ERROR_STOP on

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
