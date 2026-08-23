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
-- Re-running is not optional for `whatsappcrm_app`. A table this file has not
-- seen is one the app role holds no privilege on at all, by design (TAR-95):
-- the grant is what waits for the policy, rather than arriving ahead of it. See
-- the default-privileges block near the bottom.
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

        IF t.relname = 'lifecycle_events' THEN
            -- The first append-only table in the schema (TAR-403), and since
            -- ADR 0009 Amendment 1 ruling 2 the third that carries no RLS
            -- policy. TAR-94's `webhook_event_replays` below is the second of
            -- each.
            --
            -- **`whatsappcrm_app` is granted nothing at all**, and that is the
            -- half of ruling 2 the ruling itself does not spell out. The table
            -- keeps its `tenant_id` column but lost the `tenant_isolation`
            -- policy that filtered on it, so a grant here would let the tenant
            -- connection read every tenant's lifecycle history. The grant
            -- replaces the policy, exactly as it does for `webhook_events` and
            -- `tenant_signups` below, and `LifecycleEvent` is `system-only` in
            -- `tenant-scope.extension.ts` so a tenant-side call names the cause
            -- rather than failing with SQLSTATE 42501.
            --
            -- Neither role gets UPDATE or DELETE — including SystemPrisma, which
            -- is otherwise unrestricted by design. An audit trail of tenant
            -- suspensions and purges that the platform itself can rewrite is a
            -- record of what somebody was willing to leave behind, and
            -- SystemPrisma is the credential a mistake would run under.
            --
            -- Withholding DELETE no longer has a cascade to worry about: ruling
            -- 2 dropped both foreign keys, so nothing reaches these rows on the
            -- way past. That is the point — the trail outlives the tenant it
            -- describes, and a fixture teardown can no longer take it with it.
            --
            -- The matching trigger, `lifecycle_events_append_only`, closes the
            -- half these grants cannot: the table owner is bound by neither.
            EXECUTE format(
                'GRANT SELECT, INSERT ON TABLE "public".%I TO "whatsappcrm_system"',
                t.relname
            );

            -- The one exception, and it is a **column** grant rather than a
            -- table one (TAR-413's follow-up to TAR-403, ADR 0009 decision 7).
            -- `notified_at` is a one-way null-to-value stamp: the notification
            -- backstop re-enqueues any row still holding NULL a minute after it
            -- was written, so something has to be able to settle it.
            --
            -- Two properties are kept by making it this narrow:
            --
            --   * Table-level UPDATE stays withheld, so
            --     `has_table_privilege(..., 'UPDATE')` is still false and every
            --     other column is still unwritable after the insert.
            --   * The `lifecycle_events_append_only` trigger refuses the stamp
            --     anyway unless every other column is byte-identical and the old
            --     value was NULL. This grant chooses who may try; the trigger
            --     decides what a try may contain.
            --
            -- Skipped with a notice when the column is absent, so this file
            -- stays runnable against a database that has not had the follow-up
            -- migration yet — the same posture the function block below takes.
            IF EXISTS (
                SELECT 1
                FROM pg_attribute a
                WHERE a.attrelid = 'public.lifecycle_events'::regclass
                  AND a.attname = 'notified_at'
                  AND NOT a.attisdropped
            ) THEN
                EXECUTE format(
                    'GRANT UPDATE ("notified_at") ON TABLE "public".%I TO "whatsappcrm_system"',
                    t.relname
                );
            ELSE
                RAISE NOTICE
                    'lifecycle_events.notified_at is not present; re-run this file after applying migrations';
            END IF;

            CONTINUE;
        END IF;

        IF t.relname = 'webhook_event_replays' THEN
            -- The operator replay trail (TAR-94). Append-only, and the fourth
            -- table with no RLS policy — for the same reason as
            -- `webhook_events`, which it describes: the parked event being
            -- recovered may have no tenant at all, so there is nothing for a
            -- policy to compare against.
            --
            -- **`whatsappcrm_app` is granted nothing**, exactly as on
            -- `lifecycle_events` above and the two tables in the CASE below. The
            -- grant replaces the policy, and `WebhookEventReplay`
            -- is `system-only` in `tenant-scope.extension.ts` so a tenant-side
            -- call names the cause rather than failing with SQLSTATE 42501.
            --
            -- Neither role gets UPDATE or DELETE, including SystemPrisma. Who
            -- replayed which parked customer message is a record of an operator
            -- action on production state, and SystemPrisma is the credential a
            -- mistake would run under. `webhook_event_replays_append_only` closes
            -- the half this cannot: the table owner is bound by neither.
            --
            -- DELETE is withheld and the foreign key still cascades — a
            -- referential action runs as the table owner and is not checked
            -- against the deleting role's privileges, so removing a
            -- `webhook_events` row still takes its replay rows with it.
            EXECUTE format(
                'GRANT SELECT, INSERT ON TABLE "public".%I TO "whatsappcrm_system"',
                t.relname
            );

            CONTINUE;
        END IF;

        IF t.relname = 'platform_setting_changes' THEN
            -- The trail for a platform-setting write or clear (TAR-816). The
            -- fifth table with no RLS policy, and for the plainest reason of the
            -- five: it has no `tenant_id` at all, because a platform credential
            -- belongs to no tenant.
            --
            -- **`whatsappcrm_app` is granted nothing**, as on every table in
            -- this branch and the two in the CASE below. The grant replaces the
            -- policy, and `PlatformSettingChange` is `system-only` in
            -- `tenant-scope.extension.ts` so a tenant-side call names the cause
            -- rather than failing with SQLSTATE 42501.
            --
            -- Neither role gets UPDATE or DELETE, including SystemPrisma. Who
            -- changed the platform's Meta app secret is a record of an operator
            -- action on production state, and SystemPrisma is the credential a
            -- mistake would run under. `platform_setting_changes_append_only`
            -- closes the half this cannot: the table owner is bound by neither.
            EXECUTE format(
                'GRANT SELECT, INSERT ON TABLE "public".%I TO "whatsappcrm_system"',
                t.relname
            );

            CONTINUE;
        END IF;

        -- SystemPrisma reaches everything, including the tables that carry no
        -- policy. That is what it is for.
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

            WHEN 'webhook_events', 'tenant_signups', 'platform_settings' THEN
                -- Both are written before the tenant is known, so neither can
                -- carry a policy: there is nothing for one to compare against.
                -- TAR-94's `webhook_event_replays` is handled above, on the same
                -- reasoning and with UPDATE and DELETE withheld on top of it.
                -- With no policy to constrain them, the only safe grant is none
                -- — these are the tables where the grant, rather than RLS, is
                -- the enforcement.
                --
                --   webhook_events   TAR-39's deliberate exception in the data
                --                    model: store first, route later.
                --   tenant_signups   TAR-440. A signup exists before its tenant
                --                    does, and it holds an argon2id password
                --                    hash and a verification digest for an
                --                    account nobody owns yet. Signup runs on
                --                    SystemPrisma (ADR 0009); the model is
                --                    `system-only` in tenant-scope.extension.ts
                --                    so a tenant-side call names the cause
                --                    instead of failing with SQLSTATE 42501.
                --   platform_settings
                --                    TAR-816. The platform's own Meta app
                --                    credentials, encrypted, with no tenant_id
                --                    for a policy to compare against. A tenant
                --                    connection has no business reading the
                --                    ciphertext, the fingerprint or the change
                --                    stamp. UPDATE and DELETE stay with
                --                    SystemPrisma because a setting is current
                --                    state, not a trail — the append-only half
                --                    is `platform_setting_changes`, handled
                --                    above.
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

\echo '== app roles: function privileges =='

-- `assert_tenant_active` is TAR-51's deactivation gate, called by `TenantPrisma`
-- around every `set_config('app.tenant_id', ...)`. Both roles need `EXECUTE`.
--
-- `assert_tenant_serviceable` is the gate ADR 0009 decision 2 replaces it with,
-- and both are listed because both exist for the length of the expand → migrate
-- → contract sequence: `20260815170000` creates the new one with no callers,
-- TAR-404's engine PR moves `tenant-scope.extension.ts` onto it, and a later
-- migration drops the old one. Granting a function that is not there yet is what
-- the presence check below is for, so this stays one file across all three
-- steps.
--
-- Named rather than swept from the catalog, unlike the table loop above: the
-- `citext` and `pgcrypto` extensions put their own functions in `public` too,
-- and revoking `PUBLIC`'s execute on those would be a change to roles this file
-- knows nothing about. Only functions this project creates belong here.
--
-- Made explicit because the default is `EXECUTE TO PUBLIC`, which works right up
-- until somebody applies the routine `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA
-- public FROM PUBLIC` hardening step — and then every tenant query in the
-- product fails. Stating the grant means that step is survivable.
--
-- Skipped with a notice rather than failing when the function is absent: this
-- file is documented to run after migrations, and a cluster that has not had
-- them yet is mid-bootstrap rather than broken. The default grant still applies
-- until it is re-run.
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
            -- Start from nothing, so a grant made by hand is taken back rather
            -- than accumulated — the same discipline the table loop above
            -- follows.
            EXECUTE format('REVOKE ALL ON FUNCTION "public".%I(text) FROM PUBLIC', gate);
            EXECUTE format(
                'REVOKE ALL ON FUNCTION "public".%I(text) FROM "whatsappcrm_app", "whatsappcrm_system"',
                gate
            );
            EXECUTE format(
                'GRANT EXECUTE ON FUNCTION "public".%I(text) TO "whatsappcrm_app", "whatsappcrm_system"',
                gate
            );
        ELSE
            RAISE NOTICE
                '% is not present; re-run this file after applying migrations', gate;
        END IF;
    END LOOP;
END
$$;

-- Future tables, and the one place the two roles are treated differently
-- (TAR-95).
--
-- `whatsappcrm_system` gets them automatically. It is the cross-tenant role by
-- definition, nothing narrows what it may read, and a table it cannot reach is
-- a bug rather than a safeguard.
--
-- `whatsappcrm_app` deliberately does not, because the two halves of tenant
-- isolation are not created the same way. The grant would be automatic; the
-- `tenant_isolation` policy is hand-written per table in the migration, because
-- Prisma's schema language cannot express row-level security. Auto-granting the
-- app role makes the *grant* the thing that arrives first, so a migration that
-- adds a tenant-scoped table and forgets its RLS block ships a table that every
-- tenant can read and write with no policy to filter it. Nothing fails; the
-- symptom is one tenant reading another's rows.
--
-- Inverted, the same mistake costs a permission error on the first query and
-- nothing else, and the fix is the step that was already skipped: re-run this
-- file. The loop above grants the new table explicitly and the block below
-- gives it its `system_unrestricted` policy — at which point
-- `verify-tenant-isolation.sql` fails by name if the RLS block is still
-- missing, which is the mistake being guarded against rather than a new one.
--
-- The REVOKE is not decoration. `ALTER DEFAULT PRIVILEGES` accumulates, so in
-- an environment provisioned before this change the old grant is still on
-- record and has to be taken back rather than merely not re-issued. Revoking a
-- default privilege that was never granted changes nothing and is not an error.
--
-- Sequences stay on both roles: the schema uses none today, and a sequence
-- holds no tenant rows — `nextval` on a table nobody may write is inert.
--
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
            ' TO "whatsappcrm_system"',
            creator
        );
        EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA "public"'
            ' REVOKE ALL ON TABLES FROM "whatsappcrm_app"',
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
