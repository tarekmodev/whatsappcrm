-- Application database roles (TAR-48).
--
-- The half of tenant isolation that a migration cannot carry. The
-- 20260810140000_tenant_isolation_rls migration attaches `FORCE ROW LEVEL
-- SECURITY` and the `tenant_isolation` policy to every tenant-scoped table;
-- this file creates the roles those policies are meant to constrain, and grants
-- each one exactly the table privileges it needs.
--
-- Run it once per environment, **after** migrations:
--
--   pnpm db:roles                                   # local Docker stack
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f apps/api/prisma/sql/app-roles.sql          # any other environment
--
-- It is idempotent and safe to re-run: every step either creates what is
-- missing or re-asserts what should be true. Re-run it after any migration that
-- adds a table — new tables need their grants and their `system_unrestricted`
-- policy, and `verify-tenant-isolation.sql` fails until they have them.
--
-- ---------------------------------------------------------------------------
-- Why this is not a Prisma migration
-- ---------------------------------------------------------------------------
--
--   * Roles are cluster-scoped, migrations are database-scoped. `migrate dev`
--     replays every migration into a shadow database on the same cluster, and
--     `CREATE ROLE` does not belong in something replayed.
--   * A login role needs a password, which belongs in the environment's secret
--     store and must never be committed.
--   * `CREATE ROLE` needs `CREATEROLE`, which the deploy user on a managed
--     Postgres may not have. A migration that cannot run in every environment
--     is worse than a bootstrap step that is written down.
--
-- ---------------------------------------------------------------------------
-- The two roles
-- ---------------------------------------------------------------------------
--
--   whatsappcrm_app      What `TenantPrisma` connects as. Subject to RLS: it
--                        holds neither SUPERUSER nor BYPASSRLS, so a connection
--                        that has not set `app.tenant_id` sees zero rows.
--
--   whatsappcrm_system   What `SystemPrisma` connects as (TAR-49 owns that
--                        decision; this file provides the mechanism). It gets a
--                        second permissive policy, `system_unrestricted`, on
--                        every RLS-protected table.
--
-- `system_unrestricted` is deliberately a *policy* rather than the `BYPASSRLS`
-- role attribute. BYPASSRLS is cluster-wide, applies to every table in every
-- database, cannot be narrowed, and leaves no trace in the table's own
-- definition. A policy is per-table, shows up in `pg_policies` next to the one
-- it overrides, is dropped by the migration's `down.sql`, and can be revoked
-- one table at a time. Both are complete bypasses for the role that holds them
-- — this is the widest hole in the isolation model, and it is where a review
-- should look first. TAR-39 confines `SystemPrisma` to five call sites for
-- exactly this reason.
--
-- ---------------------------------------------------------------------------
-- Neither role can log in yet
-- ---------------------------------------------------------------------------
--
-- Both are created `NOLOGIN`. Granting login means handing out a password, and
-- a password does not belong in a file in this repository — not even a local
-- one, because the same file runs in staging. The operator enables it from the
-- environment's secret store:
--
--   ALTER ROLE whatsappcrm_app LOGIN PASSWORD '<value from the secret store>';
--
-- Nothing here needs that to be done first: `verify-tenant-isolation.sql`
-- reaches the roles with `SET ROLE`, which needs no password, and evaluates RLS
-- against `current_user` exactly as a real connection would.

\set ON_ERROR_STOP on

\echo '== app roles: creating roles =='

DO $$
DECLARE
    role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['whatsappcrm_app', 'whatsappcrm_system'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
            RAISE NOTICE 'created role %', role_name;
        END IF;

        -- Re-asserted rather than assumed. A role that picked up SUPERUSER or
        -- BYPASSRLS by hand would silently skip every policy in this database,
        -- and the failure is invisible until it is a data breach.
        EXECUTE format(
            'ALTER ROLE %I NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
            role_name
        );
    END LOOP;
END
$$;

-- Lets the migration owner run `verify-tenant-isolation.sql`, which uses
-- `SET ROLE` to evaluate the policies as each role sees them. Membership grants
-- the owner nothing it did not already have.
DO $$
DECLARE
    grantees text[];
    grantee text;
    role_name text;
BEGIN
    -- Usually the same role twice; deduplicated so a re-run stays quiet.
    SELECT array_agg(DISTINCT g) INTO grantees
    FROM unnest(ARRAY[
        pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database())),
        current_user::text
    ]) AS g;

    FOREACH grantee IN ARRAY grantees LOOP
        FOREACH role_name IN ARRAY ARRAY['whatsappcrm_app', 'whatsappcrm_system'] LOOP
            IF grantee <> role_name THEN
                EXECUTE format('GRANT %I TO %I', role_name, grantee);
            END IF;
        END LOOP;
    END LOOP;
END
$$;

\echo '== app roles: table privileges =='

GRANT USAGE ON SCHEMA "public" TO "whatsappcrm_app", "whatsappcrm_system";

-- Neither role creates objects; migrations do that, as the owner.
REVOKE CREATE ON SCHEMA "public" FROM "whatsappcrm_app", "whatsappcrm_system";

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
        ORDER BY c.relname
    LOOP
        -- Start from nothing every time, so a privilege granted by hand is
        -- taken back rather than accumulated.
        EXECUTE format('REVOKE ALL ON TABLE "public".%I FROM "whatsappcrm_app", "whatsappcrm_system"', t.relname);

        IF t.relname = '_prisma_migrations' THEN
            -- Prisma's own history. Neither application role has any business
            -- reading, let alone rewriting, the record of what has been applied.
            CONTINUE;
        END IF;

        -- SystemPrisma reaches everything, including the three tables that
        -- carry no policy. That is what it is for.
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public".%I TO "whatsappcrm_system"',
            t.relname
        );

        CASE t.relname
            WHEN 'tenants', 'plans' THEN
                -- Read-only, and not RLS-protected: `plans` is the shared
                -- product catalogue, `tenants` is the row a tenant-scoped
                -- request needs for its own name and status.
                --
                -- Known and deliberate residual exposure: SELECT on `tenants`
                -- is unfiltered, so the app role can list every tenant's id,
                -- slug, name and status. No customer data is reachable that
                -- way. Closing it means either an RLS policy on `tenants` —
                -- which TAR-39 rules out, because provisioning and host→tenant
                -- resolution both read the table before any tenant is in scope
                -- — or routing that one read through SystemPrisma. Flagged for
                -- TAR-49; writing to either table stays SystemPrisma's job.
                EXECUTE format('GRANT SELECT ON TABLE "public".%I TO "whatsappcrm_app"', t.relname);

            WHEN 'webhook_events' THEN
                -- The deliberate exception in TAR-39's data model: written
                -- before the tenant is known, so it carries no policy. With no
                -- policy to constrain it, the only safe grant is none — this is
                -- the one table where the grant, not RLS, is the enforcement.
                NULL;

            ELSE
                EXECUTE format(
                    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public".%I TO "whatsappcrm_app"',
                    t.relname
                );
        END CASE;
    END LOOP;
END
$$;

-- Future tables. Without this, a table created by the next migration is
-- invisible to both roles until someone remembers to re-run this file, and the
-- symptom is a permission error in production rather than at migrate time.
-- Attached to whichever role creates tables here: the database owner, and the
-- role running this script if that is somebody else.
DO $$
DECLARE
    creators text[];
    creator text;
BEGIN
    SELECT array_agg(DISTINCT c) INTO creators
    FROM unnest(ARRAY[
        pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database())),
        current_user::text
    ]) AS c;

    FOREACH creator IN ARRAY creators LOOP
        EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA "public"'
            ' GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES'
            ' TO "whatsappcrm_app", "whatsappcrm_system"',
            creator
        );
        EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA "public"'
            ' GRANT USAGE, SELECT ON SEQUENCES'
            ' TO "whatsappcrm_app", "whatsappcrm_system"',
            creator
        );
    END LOOP;
END
$$;

\echo '== app roles: system_unrestricted policies =='

-- One per RLS-protected table. Permissive policies combine with OR, so this
-- sits alongside `tenant_isolation` and applies only to whatsappcrm_system.
--
-- Derived from the catalog rather than from a list, so it covers whatever the
-- migrations have protected so far. A table protected after this last ran has
-- no `system_unrestricted` policy and is therefore invisible to SystemPrisma —
-- fail-closed, and `verify-tenant-isolation.sql` says so by name.
DO $$
DECLARE
    t record;
    created int := 0;
BEGIN
    FOR t IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relrowsecurity
          AND NOT EXISTS (
              SELECT 1 FROM pg_policy p
              WHERE p.polrelid = c.oid AND p.polname = 'system_unrestricted'
          )
        ORDER BY c.relname
    LOOP
        EXECUTE format(
            'CREATE POLICY "system_unrestricted" ON "public".%I'
            ' TO "whatsappcrm_system" USING (true) WITH CHECK (true)',
            t.relname
        );
        created := created + 1;
    END LOOP;

    RAISE NOTICE 'system_unrestricted: % policy/policies created', created;
END
$$;

\echo '== app roles: done =='
