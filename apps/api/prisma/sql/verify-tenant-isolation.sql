-- Two-tenant isolation check (TAR-48).
--
--   pnpm db:verify:rls                                          # local Docker stack
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f apps/api/prisma/sql/verify-tenant-isolation.sql         # any other environment
--
-- Exits non-zero on the first failed assertion, so it is a test, not a report.
-- CI runs it on every pull request (`.github/workflows/ci.yml`, the Database
-- job) — TAR-39, decision 1, rule 4: an isolation regression is silent
-- otherwise, and silent is the one thing this class of bug must not be.
--
-- ⚠️ **It writes to the database it is pointed at.** Two fixture tenants and
-- their rows are committed, read back over a fresh connection, then deleted.
-- Committing is not laziness: a transaction cannot show what a connection that
-- has *never* set `app.tenant_id` sees, and that connection is the whole point
-- of a fail-closed policy. Point this at a local or disposable database. Every
-- row it touches carries a `tar48-fixture` marker and a fixed id, and the
-- script deletes those rows before it starts as well as after it finishes, so
-- an interrupted run cleans up on the next one. Phase 1 also creates and drops
-- one empty probe table, `tar95_default_privilege_probe`, inside a single
-- transaction — it never outlives the statement that makes it, even on failure.
--
-- Reconnecting (`\connect -`) inherits psql's current connection parameters. On
-- the local Docker stack that is a Unix socket and needs no password; over TCP,
-- export `PGPASSWORD` first or psql will stop to prompt.
--
-- Prerequisites: migrations applied through 20260810140000_tenant_isolation_rls,
-- and `app-roles.sql` run afterwards.
--
-- ---------------------------------------------------------------------------
-- What it proves
-- ---------------------------------------------------------------------------
--
--   Structure   Every table carrying `tenant_id` has RLS enabled AND forced AND
--               a `tenant_isolation` policy. Every table the app role can touch
--               is either protected or on a two-entry read-only allowlist. The
--               app role holds neither SUPERUSER nor BYPASSRLS. A table created
--               *after* `app-roles.sql` last ran is reachable by the system
--               role and by nobody else — the grant waits for the policy
--               instead of arriving ahead of it (TAR-95).
--   Behaviour   On a connection that has never set the GUC, all 34 protected
--               tables return zero rows. With the GUC set, each tenant sees its
--               own rows and none of the other's. Writing another tenant's
--               `tenant_id` is rejected; updating and deleting its rows match
--               nothing. `webhook_events` is unreachable by grant. The system
--               role sees across tenants, which is what it is for.

\set ON_ERROR_STOP on

\set tenant_a '11111111-1111-7111-8111-111111111111'
\set tenant_b '22222222-2222-7222-8222-222222222222'

\echo ''
\echo '=============================================================='
\echo ' TAR-48 tenant isolation check'
\echo '=============================================================='

-- ---------------------------------------------------------------------------
-- Phase 1 — structure. Nothing is written; this is all catalog reads.
-- ---------------------------------------------------------------------------

\echo ''
\echo '-- phase 1: structure'

DO $$
DECLARE
    offenders text[] := '{}';
    t record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsappcrm_app') THEN
        RAISE EXCEPTION 'role whatsappcrm_app does not exist — run app-roles.sql first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsappcrm_system') THEN
        RAISE EXCEPTION 'role whatsappcrm_system does not exist — run app-roles.sql first';
    END IF;

    -- 1a. Every table with a tenant_id column is protected. Derived from the
    -- catalog, not from a list, so a table added by a later migration without
    -- an RLS block fails here instead of leaking quietly.
    FOR t IN
        SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname <> 'webhook_events'   -- TAR-39's deliberate exception
          AND EXISTS (
              SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
          )
        ORDER BY c.relname
    LOOP
        IF NOT t.relrowsecurity THEN
            offenders := offenders || format('%s: row level security not enabled', t.relname);
        ELSIF NOT t.relforcerowsecurity THEN
            offenders := offenders || format('%s: RLS enabled but not FORCEd — the owner bypasses it', t.relname);
        ELSIF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid AND p.polname = 'tenant_isolation') THEN
            offenders := offenders || format('%s: no tenant_isolation policy', t.relname);
        END IF;
    END LOOP;

    IF array_length(offenders, 1) > 0 THEN
        RAISE EXCEPTION E'tenant-scoped tables are unprotected:\n  %', array_to_string(offenders, E'\n  ');
    END IF;

    RAISE NOTICE 'ok: every table carrying tenant_id has FORCEd RLS and a tenant_isolation policy';
END
$$;

DO $$
DECLARE
    offenders text[] := '{}';
    t record;
    readable boolean;
    writable boolean;
    protected boolean;
BEGIN
    -- 1b. The inverse, and the one that catches the dangerous mistake: a table
    -- the app role can read or write that no policy constrains. `tenants` and
    -- `plans` are the two allowed exceptions, and only for SELECT.
    FOR t IN
        SELECT c.oid, c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname
    LOOP
        readable := has_table_privilege('whatsappcrm_app', t.oid, 'SELECT');
        writable := has_table_privilege('whatsappcrm_app', t.oid, 'INSERT')
                 OR has_table_privilege('whatsappcrm_app', t.oid, 'UPDATE')
                 OR has_table_privilege('whatsappcrm_app', t.oid, 'DELETE');

        protected := EXISTS (
            SELECT 1 FROM pg_class c2
            WHERE c2.oid = t.oid AND c2.relrowsecurity AND c2.relforcerowsecurity
        ) AND EXISTS (
            SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid AND p.polname = 'tenant_isolation'
        );

        IF t.relname IN ('tenants', 'plans') THEN
            IF writable THEN
                offenders := offenders || format('%s: app role has write privileges on an unprotected table', t.relname);
            END IF;
        ELSIF (readable OR writable) AND NOT protected THEN
            offenders := offenders || format('%s: app role has privileges on a table with no tenant_isolation policy', t.relname);
        END IF;
    END LOOP;

    IF array_length(offenders, 1) > 0 THEN
        RAISE EXCEPTION E'app role privileges outrun the policies:\n  %', array_to_string(offenders, E'\n  ');
    END IF;

    RAISE NOTICE 'ok: every table the app role can reach is policy-protected (except SELECT on tenants and plans)';
END
$$;

DO $$
DECLARE
    r record;
    offenders text[] := '{}';
    missing text[] := '{}';
    t record;
BEGIN
    -- 1c. Role attributes. SUPERUSER and BYPASSRLS skip policy evaluation
    -- outright, so either one on the app role silently voids everything above.
    FOR r IN
        SELECT rolname, rolsuper, rolbypassrls
        FROM pg_roles
        WHERE rolname IN ('whatsappcrm_app', 'whatsappcrm_system')
    LOOP
        IF r.rolsuper THEN
            offenders := offenders || format('%s: SUPERUSER', r.rolname);
        END IF;
        IF r.rolbypassrls THEN
            offenders := offenders || format('%s: BYPASSRLS', r.rolname);
        END IF;
    END LOOP;

    IF array_length(offenders, 1) > 0 THEN
        RAISE EXCEPTION E'application roles hold attributes that bypass RLS:\n  %', array_to_string(offenders, E'\n  ');
    END IF;

    RAISE NOTICE 'ok: neither application role holds SUPERUSER or BYPASSRLS';

    -- 1d. SystemPrisma's access is a policy, so it has to exist on every
    -- protected table. A missing one is fail-closed rather than dangerous, but
    -- it shows up as an empty result set in production, which is worth naming
    -- here instead of debugging there.
    FOR t IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relrowsecurity
          AND NOT EXISTS (
              SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'system_unrestricted'
          )
        ORDER BY c.relname
    LOOP
        missing := missing || t.relname;
    END LOOP;

    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION E'no system_unrestricted policy on: %\n  re-run app-roles.sql', array_to_string(missing, ', ');
    END IF;

    RAISE NOTICE 'ok: system_unrestricted covers every protected table';
END
$$;

DO $$
DECLARE
    probe constant text := 'tar95_default_privilege_probe';
    priv text;
    app_granted text[] := '{}';
    system_missing text[] := '{}';
BEGIN
    -- 1e. The default privileges themselves (TAR-95). Everything above reads
    -- the tables that exist; this one asks what happens to the *next* table,
    -- which is where the dangerous mistake lives — a migration that adds a
    -- tenant-scoped table and forgets its RLS block. The grant must not arrive
    -- ahead of the policy, so a table `app-roles.sql` has not seen must be
    -- unreachable by the app role rather than wide open to it.
    --
    -- Created for real rather than read out of `pg_default_acl`: default
    -- privileges are per creating role, and the ACL a new table actually ends
    -- up with is the composition of that entry with the built-in default.
    -- Creating one and asking is the only form of this check that cannot be
    -- fooled by reasoning about the catalog incorrectly.
    --
    -- No cleanup branch: a DO block is one transaction and DDL is transactional
    -- in PostgreSQL, so the probe table disappears on the RAISE below exactly
    -- as it does on the DROP.
    EXECUTE format(
        'CREATE TABLE "public".%I ("id" uuid PRIMARY KEY, "tenant_id" uuid NOT NULL)',
        probe
    );

    FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege('whatsappcrm_app', format('"public".%I', probe), priv) THEN
            app_granted := app_granted || priv;
        END IF;
    END LOOP;

    -- The other half, and the reason this is not simply "revoke everything":
    -- SystemPrisma still has to reach a new table on the day it is created.
    -- Losing that is a fail-closed outage rather than a leak, but it is an
    -- outage, and it would be invisible until something queried the new table.
    FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF NOT has_table_privilege('whatsappcrm_system', format('"public".%I', probe), priv) THEN
            system_missing := system_missing || priv;
        END IF;
    END LOOP;

    EXECUTE format('DROP TABLE "public".%I', probe);

    IF array_length(app_granted, 1) > 0 THEN
        RAISE EXCEPTION
            E'a brand-new table is already reachable by whatsappcrm_app (%) — default privileges are fail-OPEN\n'
            '  a migration that forgets its tenant_isolation block would ship a table every tenant can read\n'
            '  fix: the ALTER DEFAULT PRIVILEGES block in app-roles.sql must not grant ON TABLES to the app role',
            array_to_string(app_granted, ', ');
    END IF;

    IF array_length(system_missing, 1) > 0 THEN
        RAISE EXCEPTION
            E'a brand-new table is not reachable by whatsappcrm_system (missing %)\n'
            '  re-run app-roles.sql; if that does not fix it, its ALTER DEFAULT PRIVILEGES block is wrong',
            array_to_string(system_missing, ', ');
    END IF;

    RAISE NOTICE 'ok: a new table is unreachable by the app role until app-roles.sql grants it, and reachable by the system role';
END
$$;

-- ---------------------------------------------------------------------------
-- Phase 2 — the two-tenant fixture.
--
-- Inserted with the GUC set per tenant rather than as an unfiltered write: the
-- owner is subject to FORCE RLS everywhere except where it happens to be a
-- superuser, and this script has to behave identically in both cases.
-- ---------------------------------------------------------------------------

\echo ''
\echo '-- phase 2: fixture'

BEGIN;

SET LOCAL lock_timeout = '3s';

-- Leftovers from an interrupted run. Every DELETE is qualified by tenant id:
-- an unqualified one would be filtered by the policy for a normal owner and
-- would empty the table for a superuser owner, which is not a difference to
-- leave to chance.
SET LOCAL app.tenant_id = :'tenant_a';
DELETE FROM "public"."messages" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."conversations" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."contacts" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."whatsapp_accounts" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."whatsapp_business_accounts" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."users" WHERE "tenant_id" = :'tenant_a';

SET LOCAL app.tenant_id = :'tenant_b';
DELETE FROM "public"."messages" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."conversations" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."contacts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."whatsapp_accounts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."whatsapp_business_accounts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."users" WHERE "tenant_id" = :'tenant_b';

DELETE FROM "public"."tenants" WHERE "id" IN (:'tenant_a', :'tenant_b');

-- `tenants` carries no policy, so both rows insert without a GUC.
INSERT INTO "public"."tenants" ("id", "slug", "name", "status", "updated_at") VALUES
    (:'tenant_a', 'tar48-fixture-a', 'TAR-48 fixture A', 'active', now()),
    (:'tenant_b', 'tar48-fixture-b', 'TAR-48 fixture B', 'active', now());

SET LOCAL app.tenant_id = :'tenant_a';

INSERT INTO "public"."users" ("id", "tenant_id", "email", "name", "updated_at")
    VALUES ('11111111-1111-7111-8111-1111111111a1', :'tenant_a', 'agent@tar48-fixture-a.test', 'Fixture A agent', now());
-- The WABA comes before the number it owns (TAR-52): `whatsapp_accounts` is now
-- its child, and the composite FK is checked at insert.
INSERT INTO "public"."whatsapp_business_accounts" ("id", "tenant_id", "waba_id", "updated_at")
    VALUES ('11111111-1111-7111-8111-1111111111a0', :'tenant_a', 'tar48-fixture-a-waba', now());
INSERT INTO "public"."whatsapp_accounts" ("id", "tenant_id", "whatsapp_business_account_id", "phone_number_id", "display_phone_number", "updated_at")
    VALUES ('11111111-1111-7111-8111-1111111111a2', :'tenant_a', '11111111-1111-7111-8111-1111111111a0', 'tar48-fixture-a-phone', '+10000000001', now());
INSERT INTO "public"."contacts" ("id", "tenant_id", "phone_e164", "display_name", "updated_at")
    VALUES ('11111111-1111-7111-8111-1111111111a3', :'tenant_a', '+10000000011', 'Fixture A contact', now());
INSERT INTO "public"."conversations" ("id", "tenant_id", "whatsapp_account_id", "contact_id", "updated_at")
    VALUES ('11111111-1111-7111-8111-1111111111a4', :'tenant_a',
            '11111111-1111-7111-8111-1111111111a2', '11111111-1111-7111-8111-1111111111a3', now());
INSERT INTO "public"."messages" ("id", "tenant_id", "conversation_id", "direction", "status", "body", "sent_at", "updated_at")
    VALUES ('11111111-1111-7111-8111-1111111111a5', :'tenant_a', '11111111-1111-7111-8111-1111111111a4',
            'inbound', 'received', 'fixture A message', now(), now());

SET LOCAL app.tenant_id = :'tenant_b';

INSERT INTO "public"."users" ("id", "tenant_id", "email", "name", "updated_at")
    VALUES ('22222222-2222-7222-8222-2222222222b1', :'tenant_b', 'agent@tar48-fixture-b.test', 'Fixture B agent', now());
INSERT INTO "public"."whatsapp_business_accounts" ("id", "tenant_id", "waba_id", "updated_at")
    VALUES ('22222222-2222-7222-8222-2222222222b0', :'tenant_b', 'tar48-fixture-b-waba', now());
INSERT INTO "public"."whatsapp_accounts" ("id", "tenant_id", "whatsapp_business_account_id", "phone_number_id", "display_phone_number", "updated_at")
    VALUES ('22222222-2222-7222-8222-2222222222b2', :'tenant_b', '22222222-2222-7222-8222-2222222222b0', 'tar48-fixture-b-phone', '+10000000002', now());
INSERT INTO "public"."contacts" ("id", "tenant_id", "phone_e164", "display_name", "updated_at")
    VALUES ('22222222-2222-7222-8222-2222222222b3', :'tenant_b', '+10000000012', 'Fixture B contact', now());
INSERT INTO "public"."conversations" ("id", "tenant_id", "whatsapp_account_id", "contact_id", "updated_at")
    VALUES ('22222222-2222-7222-8222-2222222222b4', :'tenant_b',
            '22222222-2222-7222-8222-2222222222b2', '22222222-2222-7222-8222-2222222222b3', now());
INSERT INTO "public"."messages" ("id", "tenant_id", "conversation_id", "direction", "status", "body", "sent_at", "updated_at")
    VALUES ('22222222-2222-7222-8222-2222222222b5', :'tenant_b', '22222222-2222-7222-8222-2222222222b4',
            'inbound', 'received', 'fixture B message', now(), now());

COMMIT;

\echo 'fixture committed: 2 tenants, 6 rows each'

-- ---------------------------------------------------------------------------
-- Phase 3 — behaviour, on a connection that has never set the GUC.
--
-- The reconnect is load-bearing. Once `app.tenant_id` has been set on a
-- connection it can be cleared but not un-set: `current_setting(…, true)`
-- returns the empty string afterwards, not NULL. Both must mean "no tenant",
-- and this is the only way to observe the NULL case for real.
-- ---------------------------------------------------------------------------

\connect -

\set ON_ERROR_STOP on

\echo ''
\echo '-- phase 3: behaviour'

DO $$
DECLARE
    tenant_a constant uuid := '11111111-1111-7111-8111-111111111111';
    tenant_b constant uuid := '22222222-2222-7222-8222-222222222222';
    t record;
    n bigint;
    leaked text[] := '{}';
    scoped_tables int := 0;
BEGIN
    IF current_setting('app.tenant_id', true) IS NOT NULL THEN
        RAISE EXCEPTION 'expected a connection that has never set app.tenant_id, got %',
            quote_literal(current_setting('app.tenant_id', true));
    END IF;

    EXECUTE 'SET ROLE "whatsappcrm_app"';

    -- 3a. No GUC, every protected table, zero rows. Not a sample: the loop
    -- covers whatever the catalog says is protected, so this stays true for
    -- tables added long after this was written.
    FOR t IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
        WHERE n.nspname = 'public'
        ORDER BY c.relname
    LOOP
        scoped_tables := scoped_tables + 1;
        EXECUTE format('SELECT count(*) FROM "public".%I', t.relname) INTO n;
        IF n <> 0 THEN
            leaked := leaked || format('%s: %s rows', t.relname, n);
        END IF;
    END LOOP;

    IF array_length(leaked, 1) > 0 THEN
        RAISE EXCEPTION E'rows visible with no tenant in scope — RLS is NOT fail-closed:\n  %',
            array_to_string(leaked, E'\n  ');
    END IF;

    -- A loop over nothing passes trivially, which is the one way this check
    -- could lie about the thing it exists to prove.
    IF scoped_tables = 0 THEN
        RAISE EXCEPTION 'no tenant_isolation policies found at all — is the RLS migration applied?';
    END IF;

    RAISE NOTICE 'ok: no GUC set -> 0 rows across all % protected tables', scoped_tables;

    -- 3b. Tenant A sees exactly its own rows.
    PERFORM set_config('app.tenant_id', tenant_a::text, false);

    SELECT count(*) INTO n FROM "public"."contacts";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 contact, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."messages";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 message, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."conversations";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 conversation, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."users";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 user, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."contacts" WHERE "tenant_id" <> tenant_a;
    IF n <> 0 THEN RAISE EXCEPTION 'tenant A saw % contacts belonging to another tenant', n; END IF;

    -- The explicit cross-tenant read: asking for tenant B by id, as tenant A.
    SELECT count(*) INTO n FROM "public"."contacts" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read returned % rows', n; END IF;

    SELECT count(*) INTO n FROM "public"."messages" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of messages returned % rows', n; END IF;

    RAISE NOTICE 'ok: tenant A sees its own 6 rows and none of tenant B''s';

    -- 3c. Tenant B, symmetrically. Same connection, same role — only the GUC
    -- changed, which is exactly what the client extension will do per request.
    PERFORM set_config('app.tenant_id', tenant_b::text, false);

    SELECT count(*) INTO n FROM "public"."contacts";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant B: expected 1 contact, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."contacts" WHERE "tenant_id" = tenant_a;
    IF n <> 0 THEN RAISE EXCEPTION 'tenant B saw % of tenant A''s contacts', n; END IF;

    RAISE NOTICE 'ok: tenant B sees its own rows and none of tenant A''s';

    -- 3d. WITH CHECK. Reading is only half of it: a handler that takes a
    -- tenant_id from a request body must not be able to write into another
    -- tenant either.
    PERFORM set_config('app.tenant_id', tenant_a::text, false);

    BEGIN
        INSERT INTO "public"."contacts" ("id", "tenant_id", "phone_e164", "updated_at")
        VALUES ('11111111-1111-7111-8111-1111111111ff', tenant_b, '+10000000099', now());
        RAISE EXCEPTION 'insert into another tenant succeeded — WITH CHECK is not enforcing';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'ok: insert carrying another tenant''s id rejected (SQLSTATE 42501)';
    END;

    -- 3e. Update and delete of another tenant's rows match nothing. No error —
    -- the rows are simply not there to be touched, which is the correct shape:
    -- an attacker learns nothing from the response.
    UPDATE "public"."contacts" SET "display_name" = 'hijacked' WHERE "tenant_id" = tenant_b;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant UPDATE modified % rows', n; END IF;

    DELETE FROM "public"."contacts" WHERE "tenant_id" = tenant_b;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant DELETE removed % rows', n; END IF;

    RAISE NOTICE 'ok: cross-tenant UPDATE and DELETE match 0 rows';

    -- 3f. The reset path. This is the empty-string case the NULLIF in the
    -- policy exists for; without it this raises a cast error instead of
    -- returning nothing.
    PERFORM set_config('app.tenant_id', '', false);

    SELECT count(*) INTO n FROM "public"."contacts";
    IF n <> 0 THEN RAISE EXCEPTION 'GUC reset to empty string exposed % contacts', n; END IF;

    RAISE NOTICE 'ok: GUC cleared to the empty string -> 0 rows';

    -- 3g. webhook_events carries no policy by design, so the grant is the
    -- enforcement. The app role must not be able to read it at all.
    BEGIN
        EXECUTE 'SELECT count(*) FROM "public"."webhook_events"';
        RAISE EXCEPTION 'app role can read webhook_events — it holds no policy and must hold no grant';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'ok: webhook_events unreachable by the app role (no grant)';
    END;

    -- 3h. The system role, with no GUC at all, sees both tenants. Proves the
    -- SystemPrisma path works — and, read the other way, is the measure of what
    -- a leaked system credential would reach.
    EXECUTE 'RESET ROLE';
    EXECUTE 'SET ROLE "whatsappcrm_system"';
    PERFORM set_config('app.tenant_id', '', false);

    SELECT count(*) INTO n FROM "public"."contacts" WHERE "tenant_id" IN (tenant_a, tenant_b);
    IF n <> 2 THEN RAISE EXCEPTION 'system role: expected both fixture contacts, saw %', n; END IF;

    RAISE NOTICE 'ok: system role reads across tenants with no GUC set';

    EXECUTE 'RESET ROLE';
END
$$;

-- ---------------------------------------------------------------------------
-- Phase 4 — cleanup, and proof that it worked.
-- ---------------------------------------------------------------------------

\echo ''
\echo '-- phase 4: cleanup'

BEGIN;

SET LOCAL lock_timeout = '3s';

SET LOCAL app.tenant_id = :'tenant_a';
DELETE FROM "public"."messages" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."conversations" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."contacts" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."whatsapp_accounts" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."whatsapp_business_accounts" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."users" WHERE "tenant_id" = :'tenant_a';

SET LOCAL app.tenant_id = :'tenant_b';
DELETE FROM "public"."messages" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."conversations" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."contacts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."whatsapp_accounts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."whatsapp_business_accounts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."users" WHERE "tenant_id" = :'tenant_b';

DELETE FROM "public"."tenants" WHERE "id" IN (:'tenant_a', :'tenant_b');

COMMIT;

DO $$
DECLARE
    tenant_a constant uuid := '11111111-1111-7111-8111-111111111111';
    tenant_b constant uuid := '22222222-2222-7222-8222-222222222222';
    n bigint;
BEGIN
    -- Checked as the system role: the owner without a GUC would see nothing
    -- either way, which would make this assertion prove nothing.
    EXECUTE 'SET ROLE "whatsappcrm_system"';

    SELECT count(*) INTO n FROM "public"."contacts" WHERE "tenant_id" IN (tenant_a, tenant_b);
    IF n <> 0 THEN RAISE EXCEPTION 'fixture contacts survived cleanup: %', n; END IF;

    SELECT count(*) INTO n FROM "public"."tenants" WHERE "id" IN (tenant_a, tenant_b);
    IF n <> 0 THEN RAISE EXCEPTION 'fixture tenants survived cleanup: %', n; END IF;

    EXECUTE 'RESET ROLE';

    RAISE NOTICE 'ok: fixture removed';
END
$$;

\echo ''
\echo '=============================================================='
\echo ' PASS — tenant isolation is enforced at the data layer'
\echo '=============================================================='
\echo ''
