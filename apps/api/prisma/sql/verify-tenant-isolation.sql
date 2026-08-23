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
-- and `app-roles.sql` run afterwards. Re-run `app-roles.sql` after any later
-- migration that adds a table: a new table has no grants and no
-- `system_unrestricted` policy until it does, and phase 1 names it here.
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
--   Behaviour   On a connection that has never set the GUC, every protected
--               table returns zero rows. With the GUC set, each tenant sees its
--               own rows and none of the other's. Writing another tenant's
--               `tenant_id` is rejected; updating and deleting its rows match
--               nothing. `webhook_events`, `webhook_event_replays` and
--               `tenant_signups` are unreachable by grant. The system role sees
--               across tenants, which is what it is for.
--
-- The fixture carries a row in `tickets` and `ticket_counters` (TAR-74), one in
-- each of the five auth tables — `teams`, `invites`, `invite_teams`, `sessions`,
-- `password_reset_tokens` (TAR-54) — one in each of the three SLA tables
-- (TAR-270, with `sla_alerts` now `notifications`), one in each of TAR-27's four
-- — `workflows`, `workflow_runs`, `workflow_references`, `ticket_tags`, plus the
-- `tags` row they reference (TAR-394) — and the conversation tables. Phase 3a is a
-- loop over whatever the catalog says is protected, so an empty table passes it
-- trivially; a real row in the tables those stories added is what makes the
-- assertion mean something for them. TAR-54's tables earn their rows twice over:
-- they hold the credentials of the product, so "a query outside its own tenant
-- returns nothing" is the acceptance criterion itself rather than a general
-- property they inherit. `notifications` earns its own for a narrower reason: 0006
-- requires an isolation test to ship with the migration that adds it, because the
-- sweeps that write it are the code paths in the product that read across tenants
-- at all. TAR-27's four earn theirs because a workflow is tenant-authored
-- automation that *writes to tickets* — one tenant reaching another's rules is not
-- a data leak, it is a robot acting on somebody else's helpdesk.
--
-- Both tenants deliberately hold a tag named `escalated` and a workflow named
-- `Escalate stale tickets`: the unique keys are `(tenant_id, name)`, so this must
-- be legal, and identically named rows on both sides are what stop a
-- "saw 1 row of my own" assertion passing on a query that ignored the tenant.
--
-- TAR-468 adds a row to `ticket_events` and an `escalation` row to
-- `notifications` in each tenant — a manual escalation and the supervisor it
-- named. They earn their own for a third reason again: those two are the only
-- fixture rows carrying text a person typed about a named colleague, and the
-- composite foreign key between them is a second enforcement mechanism that RLS
-- does not cover. Phase 3d exercises it directly, because a foreign-key
-- violation and a policy rejection are different failures and only one of them
-- is what that key exists for.
--
-- The *constraints* those tables exist for are separate properties, proven
-- elsewhere: `src/prisma/ticket-active-uniqueness.int-spec.ts` for TAR-74's
-- index, and TAR-55/56/57's own tests for single-use redemption and lockout.
-- This file is about isolation only.
--
-- Nothing here is a credential. Every `token_hash` in the fixture is a literal
-- string that says what it is; no value in this file is the hash of a token
-- that exists, and no plaintext token, password or secret appears in it.

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
          -- ADR 0009 Amendment 1 ruling 2. `lifecycle_events` keeps `tenant_id`
          -- as a recorded identifier rather than a reference, and carries no
          -- policy on purpose: the trail outlives the tenant, and the composite
          -- FK to `users` made the purge impossible to finish. The app role
          -- holds no grant on it — 3g below asserts that by name, which is the
          -- half that actually protects it.
          AND c.relname <> 'lifecycle_events'
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
-- TAR-27's four tables, before the tags, teams, tickets and workflows they point
-- at. `workflow_references` goes first and explicitly: its tag and team foreign
-- keys are `NO ACTION`, so a row here outliving its tag would refuse that tag's
-- delete at the end of the statement rather than cascading with it.
DELETE FROM "public"."workflow_references" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."workflow_runs" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."workflows" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."ticket_tags" WHERE "tenant_id" = :'tenant_a';
-- TAR-270's three tables, before the ticket they hang off. They cascade from
-- `tickets`, so this is belt and braces — but notifications before timers before
-- policies is the order their own foreign keys require. The table was
-- `sla_alerts` until TAR-394 renamed it (0009, decision 7).
DELETE FROM "public"."notifications" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."sla_timers" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."sla_policies" WHERE "tenant_id" = :'tenant_a';
-- TAR-468's events, after the notifications above that reference them.
DELETE FROM "public"."ticket_events" WHERE "tenant_id" = :'tenant_a';
-- Before the conversation and contact they reference: those foreign keys are
-- NoAction, so the parents cannot go first.
DELETE FROM "public"."tickets" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."ticket_counters" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."conversations" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."contacts" WHERE "tenant_id" = :'tenant_a';
-- After `contact_tags` (which the contact above cascades), `ticket_tags` and
-- `workflow_references` — the first two cascade from the tag, the third refuses it.
DELETE FROM "public"."tags" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."whatsapp_accounts" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."whatsapp_business_accounts" WHERE "tenant_id" = :'tenant_a';
-- TAR-54's tables, before the users, invites and teams they hang off. Their
-- foreign keys cascade, so this is belt and braces — but every delete in this
-- block is explicit and tenant-qualified, and a cascade that quietly stops
-- being one should surface here rather than as a stray row later.
DELETE FROM "public"."password_reset_tokens" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."sessions" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."invite_teams" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."invites" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."teams" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."users" WHERE "tenant_id" = :'tenant_a';

SET LOCAL app.tenant_id = :'tenant_b';
DELETE FROM "public"."messages" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."workflow_references" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."workflow_runs" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."workflows" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."ticket_tags" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."notifications" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."sla_timers" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."sla_policies" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."ticket_events" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."tickets" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."ticket_counters" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."conversations" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."contacts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."tags" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."whatsapp_accounts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."whatsapp_business_accounts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."password_reset_tokens" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."sessions" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."invite_teams" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."invites" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."teams" WHERE "tenant_id" = :'tenant_b';
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
-- TAR-74's two tables. The counter row is written with the column list the
-- allocator actually uses — no `updated_at` — so a future migration that drops
-- its `now()` default breaks the fixture here rather than ticket creation in
-- production.
INSERT INTO "public"."ticket_counters" ("tenant_id", "next_number")
    VALUES (:'tenant_a', 2);
INSERT INTO "public"."tickets" ("id", "tenant_id", "number", "status", "conversation_id", "contact_id", "updated_at")
    VALUES ('11111111-1111-7111-8111-1111111111a6', :'tenant_a', 1, 'open',
            '11111111-1111-7111-8111-1111111111a4', '11111111-1111-7111-8111-1111111111a3', now());
-- TAR-54's auth tables. A live session, a pending invite carrying a team, and
-- an outstanding password reset — the three shapes an attacker would most like
-- to read across a tenant boundary.
--
-- Every `token_hash` is a literal label, not the hash of anything. A real one
-- is the SHA-256 hex of 32 random bytes; putting a plausible-looking one here
-- would invite somebody to wonder what it decodes to.
INSERT INTO "public"."teams" ("id", "tenant_id", "name", "updated_at")
    VALUES ('11111111-1111-7111-8111-1111111111a7', :'tenant_a', 'Fixture A team', now());
INSERT INTO "public"."invites" ("id", "tenant_id", "email", "role", "token_hash", "expires_at")
    VALUES ('11111111-1111-7111-8111-1111111111a8', :'tenant_a', 'invited@tar48-fixture-a.test', 'agent',
            'tar54-fixture-a-invite-token-hash-not-a-real-token', now() + interval '7 days');
INSERT INTO "public"."invite_teams" ("tenant_id", "invite_id", "team_id")
    VALUES (:'tenant_a', '11111111-1111-7111-8111-1111111111a8', '11111111-1111-7111-8111-1111111111a7');
INSERT INTO "public"."sessions" ("id", "tenant_id", "user_id", "token_hash", "expires_at", "absolute_expires_at")
    VALUES ('11111111-1111-7111-8111-1111111111a9', :'tenant_a', '11111111-1111-7111-8111-1111111111a1',
            'tar54-fixture-a-session-token-hash-not-a-real-token',
            now() + interval '12 hours', now() + interval '30 days');
INSERT INTO "public"."password_reset_tokens" ("id", "tenant_id", "user_id", "token_hash", "expires_at")
    VALUES ('11111111-1111-7111-8111-1111111111aa', :'tenant_a', '11111111-1111-7111-8111-1111111111a1',
            'tar54-fixture-a-reset-token-hash-not-a-real-token', now() + interval '60 minutes');
-- TAR-270's three tables: the tenant's SLA configuration, a timer that has
-- already breached, and the supervisor alert it raised. The timer is `breached`
-- rather than `running` on purpose — it is the state that has an alert row
-- hanging off it, and an alert is the row here that names a person.
INSERT INTO "public"."sla_policies" ("id", "tenant_id", "name", "first_response_minutes", "updated_at")
    VALUES ('11111111-1111-7111-8111-1111111111ab', :'tenant_a', 'tar48-fixture-a-policy', 60, now());
INSERT INTO "public"."sla_timers" ("id", "tenant_id", "ticket_id", "policy_id", "kind", "state", "due_at", "breached_at")
    VALUES ('11111111-1111-7111-8111-1111111111ac', :'tenant_a', '11111111-1111-7111-8111-1111111111a6',
            '11111111-1111-7111-8111-1111111111ab', 'first_response', 'breached',
            now() - interval '30 minutes', now() - interval '29 minutes');
INSERT INTO "public"."notifications" ("id", "tenant_id", "type", "sla_timer_id", "ticket_id", "recipient_user_id", "kind", "due_at")
    VALUES ('11111111-1111-7111-8111-1111111111ad', :'tenant_a', 'sla_breach', '11111111-1111-7111-8111-1111111111ac',
            '11111111-1111-7111-8111-1111111111a6', '11111111-1111-7111-8111-1111111111a1',
            'first_response', now() - interval '30 minutes');
-- TAR-27's five: a tag, an active workflow that references it, the tag applied to
-- the ticket, the reference row that would refuse the tag's delete, and one run.
-- The workflow is the story's own example — "unresolved for 4 hours → tag
-- `escalated`" — because the rows this script has to keep inside the tenant
-- boundary are the ones a real tenant will have.
INSERT INTO "public"."tags" ("id", "tenant_id", "name")
    VALUES ('11111111-1111-7111-8111-1111111111c0', :'tenant_a', 'escalated');
INSERT INTO "public"."workflows" ("id", "tenant_id", "name", "is_active", "position", "trigger_type", "definition", "version", "updated_at")
    VALUES ('11111111-1111-7111-8111-1111111111c1', :'tenant_a', 'Escalate stale tickets', true, 0,
            'ticket_unresolved_for',
            '{"trigger":{"type":"ticket_unresolved_for","minutes":240},"conditions":[],"actions":[{"type":"add_ticket_tag","tagId":"11111111-1111-7111-8111-1111111111c0"}]}'::jsonb,
            1, now());
INSERT INTO "public"."workflow_references" ("id", "tenant_id", "workflow_id", "tag_id")
    VALUES ('11111111-1111-7111-8111-1111111111c2', :'tenant_a', '11111111-1111-7111-8111-1111111111c1',
            '11111111-1111-7111-8111-1111111111c0');
INSERT INTO "public"."ticket_tags" ("id", "tenant_id", "ticket_id", "tag_id")
    VALUES ('11111111-1111-7111-8111-1111111111c3', :'tenant_a', '11111111-1111-7111-8111-1111111111a6',
            '11111111-1111-7111-8111-1111111111c0');
INSERT INTO "public"."workflow_runs" ("id", "tenant_id", "workflow_id", "ticket_id", "workflow_version", "dedupe_key", "status", "results")
    VALUES ('11111111-1111-7111-8111-1111111111c4', :'tenant_a', '11111111-1111-7111-8111-1111111111c1',
            '11111111-1111-7111-8111-1111111111a6', 1,
            'ticket:11111111-1111-7111-8111-1111111111a6', 'succeeded',
            '[{"index":0,"type":"add_ticket_tag","outcome":"applied","reason":null}]'::jsonb);
-- TAR-468's pair: a manual escalation and the supervisor it named. The event row
-- is the audit trail TAR-32 asks for, and the `escalation` notification is the
-- record that the supervisor was told. `data.reason` is the agent's free text —
-- the one value in this fixture that carries something a person typed about a
-- named colleague, which is why both are named in the assertions below rather
-- than left to the catalog-driven loop.
INSERT INTO "public"."ticket_events" ("id", "tenant_id", "ticket_id", "type", "actor_user_id", "data")
    VALUES ('11111111-1111-7111-8111-1111111111ae', :'tenant_a', '11111111-1111-7111-8111-1111111111a6',
            'escalated', '11111111-1111-7111-8111-1111111111a1',
            '{"reason": "fixture A escalation reason", "cause": "agent"}'::jsonb);
INSERT INTO "public"."notifications" ("id", "tenant_id", "type", "ticket_event_id", "ticket_id", "recipient_user_id")
    VALUES ('11111111-1111-7111-8111-1111111111af', :'tenant_a', 'escalation',
            '11111111-1111-7111-8111-1111111111ae', '11111111-1111-7111-8111-1111111111a6',
            '11111111-1111-7111-8111-1111111111a1');

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
INSERT INTO "public"."ticket_counters" ("tenant_id", "next_number")
    VALUES (:'tenant_b', 2);
-- Ticket #1 in tenant B as well. Two tenants both holding ticket number 1 is
-- correct — the key is `(tenant_id, number)` — and asserting it here means a
-- future "globally unique ticket number" cannot slip in unnoticed.
INSERT INTO "public"."tickets" ("id", "tenant_id", "number", "status", "conversation_id", "contact_id", "updated_at")
    VALUES ('22222222-2222-7222-8222-2222222222b6', :'tenant_b', 1, 'open',
            '22222222-2222-7222-8222-2222222222b4', '22222222-2222-7222-8222-2222222222b3', now());
-- TAR-54's auth tables in tenant B, at the same email address tenant A invited.
-- Two tenants both holding a pending invite for `invited@…` is correct — auth
-- is tenant-scoped, and the same person may hold accounts at two client orgs
-- (TAR-35's assumptions) — so asserting it here means a future "globally unique
-- invite address" cannot slip in unnoticed. The addresses differ only by
-- domain because `invites.email` is the fixture's own namespace; what the
-- partial unique index actually keys on is `(tenant_id, email)`.
INSERT INTO "public"."teams" ("id", "tenant_id", "name", "updated_at")
    VALUES ('22222222-2222-7222-8222-2222222222b7', :'tenant_b', 'Fixture B team', now());
INSERT INTO "public"."invites" ("id", "tenant_id", "email", "role", "token_hash", "expires_at")
    VALUES ('22222222-2222-7222-8222-2222222222b8', :'tenant_b', 'invited@tar48-fixture-b.test', 'agent',
            'tar54-fixture-b-invite-token-hash-not-a-real-token', now() + interval '7 days');
INSERT INTO "public"."invite_teams" ("tenant_id", "invite_id", "team_id")
    VALUES (:'tenant_b', '22222222-2222-7222-8222-2222222222b8', '22222222-2222-7222-8222-2222222222b7');
INSERT INTO "public"."sessions" ("id", "tenant_id", "user_id", "token_hash", "expires_at", "absolute_expires_at")
    VALUES ('22222222-2222-7222-8222-2222222222b9', :'tenant_b', '22222222-2222-7222-8222-2222222222b1',
            'tar54-fixture-b-session-token-hash-not-a-real-token',
            now() + interval '12 hours', now() + interval '30 days');
INSERT INTO "public"."password_reset_tokens" ("id", "tenant_id", "user_id", "token_hash", "expires_at")
    VALUES ('22222222-2222-7222-8222-2222222222ba', :'tenant_b', '22222222-2222-7222-8222-2222222222b1',
            'tar54-fixture-b-reset-token-hash-not-a-real-token', now() + interval '60 minutes');
-- Tenant B's SLA rows, mirroring tenant A's. Both tenants holding a breached
-- timer and an alert is what makes the cross-tenant assertions below mean
-- something: with rows on only one side, "saw 0 of the other's" is trivially
-- true.
INSERT INTO "public"."sla_policies" ("id", "tenant_id", "name", "first_response_minutes", "updated_at")
    VALUES ('22222222-2222-7222-8222-2222222222bb', :'tenant_b', 'tar48-fixture-b-policy', 60, now());
INSERT INTO "public"."sla_timers" ("id", "tenant_id", "ticket_id", "policy_id", "kind", "state", "due_at", "breached_at")
    VALUES ('22222222-2222-7222-8222-2222222222bc', :'tenant_b', '22222222-2222-7222-8222-2222222222b6',
            '22222222-2222-7222-8222-2222222222bb', 'first_response', 'breached',
            now() - interval '30 minutes', now() - interval '29 minutes');
INSERT INTO "public"."notifications" ("id", "tenant_id", "type", "sla_timer_id", "ticket_id", "recipient_user_id", "kind", "due_at")
    VALUES ('22222222-2222-7222-8222-2222222222bd', :'tenant_b', 'sla_breach', '22222222-2222-7222-8222-2222222222bc',
            '22222222-2222-7222-8222-2222222222b6', '22222222-2222-7222-8222-2222222222b1',
            'first_response', now() - interval '30 minutes');
-- Tenant B's workflow rows, mirroring tenant A's — including a tag with the *same
-- name*, which is correct (the key is `(tenant_id, name)`) and is what makes the
-- cross-tenant reads below mean something. Both tenants also hold a workflow
-- called `Escalate stale tickets`, for the same reason.
INSERT INTO "public"."tags" ("id", "tenant_id", "name")
    VALUES ('22222222-2222-7222-8222-2222222222c0', :'tenant_b', 'escalated');
INSERT INTO "public"."workflows" ("id", "tenant_id", "name", "is_active", "position", "trigger_type", "definition", "version", "updated_at")
    VALUES ('22222222-2222-7222-8222-2222222222c1', :'tenant_b', 'Escalate stale tickets', true, 0,
            'ticket_unresolved_for',
            '{"trigger":{"type":"ticket_unresolved_for","minutes":240},"conditions":[],"actions":[{"type":"add_ticket_tag","tagId":"22222222-2222-7222-8222-2222222222c0"}]}'::jsonb,
            1, now());
INSERT INTO "public"."workflow_references" ("id", "tenant_id", "workflow_id", "tag_id")
    VALUES ('22222222-2222-7222-8222-2222222222c2', :'tenant_b', '22222222-2222-7222-8222-2222222222c1',
            '22222222-2222-7222-8222-2222222222c0');
INSERT INTO "public"."ticket_tags" ("id", "tenant_id", "ticket_id", "tag_id")
    VALUES ('22222222-2222-7222-8222-2222222222c3', :'tenant_b', '22222222-2222-7222-8222-2222222222b6',
            '22222222-2222-7222-8222-2222222222c0');
INSERT INTO "public"."workflow_runs" ("id", "tenant_id", "workflow_id", "ticket_id", "workflow_version", "dedupe_key", "status", "results")
    VALUES ('22222222-2222-7222-8222-2222222222c4', :'tenant_b', '22222222-2222-7222-8222-2222222222c1',
            '22222222-2222-7222-8222-2222222222b6', 1,
            'ticket:22222222-2222-7222-8222-2222222222b6', 'succeeded',
            '[{"index":0,"type":"add_ticket_tag","outcome":"applied","reason":null}]'::jsonb);
-- Tenant B's escalation, mirroring tenant A's, for the reason above: with rows
-- on only one side, "saw 0 of the other's" is trivially true.
INSERT INTO "public"."ticket_events" ("id", "tenant_id", "ticket_id", "type", "actor_user_id", "data")
    VALUES ('22222222-2222-7222-8222-2222222222be', :'tenant_b', '22222222-2222-7222-8222-2222222222b6',
            'escalated', '22222222-2222-7222-8222-2222222222b1',
            '{"reason": "fixture B escalation reason", "cause": "agent"}'::jsonb);
INSERT INTO "public"."notifications" ("id", "tenant_id", "type", "ticket_event_id", "ticket_id", "recipient_user_id")
    VALUES ('22222222-2222-7222-8222-2222222222bf', :'tenant_b', 'escalation',
            '22222222-2222-7222-8222-2222222222be', '22222222-2222-7222-8222-2222222222b6',
            '22222222-2222-7222-8222-2222222222b1');

COMMIT;

\echo 'fixture committed: 2 tenants, 23 rows each'

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
    trail text;
    priv text;
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

    -- TAR-74's two tables, read the same two ways: own rows visible, the other
    -- tenant's not — including `ticket_counters`, whose primary key is the
    -- tenant id itself and which would otherwise be trivially guessable.
    SELECT count(*) INTO n FROM "public"."tickets";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 ticket, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."tickets" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of tickets returned % rows', n; END IF;

    SELECT count(*) INTO n FROM "public"."ticket_counters";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 ticket_counters row, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."ticket_counters" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of ticket_counters returned % rows', n; END IF;

    -- TAR-54's four auth tables, read the same two ways. This is the story's
    -- second acceptance criterion stated as an assertion: a query for another
    -- tenant's session, invite, invited team or reset token returns nothing.
    -- Named one table at a time rather than folded into the 3a loop because a
    -- missing policy on any of these is the one failure that hands over an
    -- account rather than a row of business data.
    SELECT count(*) INTO n FROM "public"."sessions";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 session, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."sessions" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of sessions returned % rows', n; END IF;

    SELECT count(*) INTO n FROM "public"."password_reset_tokens";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 password reset token, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."password_reset_tokens" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of password_reset_tokens returned % rows', n; END IF;

    SELECT count(*) INTO n FROM "public"."invites";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 invite, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."invites" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of invites returned % rows', n; END IF;

    SELECT count(*) INTO n FROM "public"."invite_teams";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 invite_teams row, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."invite_teams" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of invite_teams returned % rows', n; END IF;

    -- The token hash is the lookup key on every one of these tables: the
    -- application holds a token from a cookie or a link and asks which row it
    -- belongs to. So the read that matters is not "select all" but "select by
    -- hash", and that is the one an attacker who has somehow obtained another
    -- tenant's token would make. It must find nothing, because the policy
    -- filters before the unique index is consulted.
    SELECT count(*) INTO n FROM "public"."sessions"
        WHERE "token_hash" = 'tar54-fixture-b-session-token-hash-not-a-real-token';
    IF n <> 0 THEN RAISE EXCEPTION 'another tenant''s session was reachable by token hash'; END IF;

    SELECT count(*) INTO n FROM "public"."password_reset_tokens"
        WHERE "token_hash" = 'tar54-fixture-b-reset-token-hash-not-a-real-token';
    IF n <> 0 THEN RAISE EXCEPTION 'another tenant''s reset token was reachable by token hash'; END IF;

    SELECT count(*) INTO n FROM "public"."invites"
        WHERE "token_hash" = 'tar54-fixture-b-invite-token-hash-not-a-real-token';
    IF n <> 0 THEN RAISE EXCEPTION 'another tenant''s invite was reachable by token hash'; END IF;

    -- TAR-270's three tables. `notifications` is named twice over, the way
    -- TAR-54's tables are: its rows are written by jobs that have *just finished*
    -- reading across every tenant — the SLA breach sweep (0006, decision 2) and
    -- now the workflow sweep (0009, decision 3) — so "the phase-2 write landed in
    -- the tenant it was grouped under" is the acceptance criterion rather than a
    -- property it inherits. A row also names a supervisor, a ticket number and a
    -- missed deadline.
    SELECT count(*) INTO n FROM "public"."sla_policies";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 SLA policy, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."sla_policies" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of sla_policies returned % rows', n; END IF;

    SELECT count(*) INTO n FROM "public"."sla_timers";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 SLA timer, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."sla_timers" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of sla_timers returned % rows', n; END IF;

    -- The sweep's own phase-1 predicate, run as the app role: it carries no
    -- tenant term at all, and RLS is the only thing between it and every
    -- tenant's due timers. That is precisely why 0006 confines it to
    -- SystemPrisma — and why this asserts that the app role, if it ever issued
    -- the same query, would still see one row rather than two.
    SELECT count(*) INTO n FROM "public"."sla_timers"
        WHERE "state" = 'breached' AND "due_at" <= now();
    IF n <> 1 THEN RAISE EXCEPTION 'the unscoped sweep predicate returned % rows to a scoped role', n; END IF;

    -- Two now: the SLA breach above and TAR-468's escalation below. Counted by
    -- type as well as in total, because "2 notifications" would still pass if the
    -- escalation had silently been written as a breach — and the two are read by
    -- different endpoints.
    SELECT count(*) INTO n FROM "public"."notifications";
    IF n <> 2 THEN RAISE EXCEPTION 'tenant A: expected 2 notifications, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."notifications" WHERE "type" = 'sla_breach';
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 sla_breach notification, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."notifications" WHERE "type" = 'escalation';
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 escalation notification, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."notifications" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of notifications returned % rows', n; END IF;

    -- By id, which is the read `GET /api/v1/sla-alerts/{id}` and the acknowledge
    -- endpoint make. It must find nothing, so the endpoint answers 404 on the
    -- policy rather than on an application check that could be forgotten.
    SELECT count(*) INTO n FROM "public"."notifications"
        WHERE "id" = '22222222-2222-7222-8222-2222222222bd';
    IF n <> 0 THEN RAISE EXCEPTION 'another tenant''s notification was reachable by id'; END IF;

    -- TAR-27's four tables. Each is named rather than left to the phase-3a loop
    -- for a reason the loop cannot cover: a workflow is tenant-authored automation
    -- that *writes to tickets*, so one tenant reading — let alone running —
    -- another's rules is the whole of TAR-27's isolation criterion. The two
    -- tenants hold identically named tags and workflows, so a query that ignored
    -- the tenant would return two rows here rather than nothing, which is what
    -- makes each `<> 1` assertion mean something.
    SELECT count(*) INTO n FROM "public"."tags";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 tag, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."workflows";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 workflow, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."workflows" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of workflows returned % rows', n; END IF;

    -- The evaluation read the sweep and every event trigger make, verbatim: the
    -- active workflows for one trigger type. It carries no tenant term of its own
    -- inside a worker, so RLS is the only thing standing between it and another
    -- tenant's rules.
    SELECT count(*) INTO n FROM "public"."workflows"
        WHERE "is_active" AND "trigger_type" = 'ticket_unresolved_for';
    IF n <> 1 THEN RAISE EXCEPTION 'the evaluation predicate returned % rows to a scoped role', n; END IF;

    SELECT count(*) INTO n FROM "public"."workflow_runs";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 workflow run, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."workflow_runs" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of workflow_runs returned % rows', n; END IF;

    -- By dedupe key, which is the claim `INSERT ... ON CONFLICT` reads. Tenant B's
    -- key names tenant B's ticket, so this finding a row would mean the unique
    -- index is shared across tenants — and a claim that collides across the
    -- boundary is one tenant's automation silently not firing.
    SELECT count(*) INTO n FROM "public"."workflow_runs"
        WHERE "dedupe_key" = 'ticket:22222222-2222-7222-8222-2222222222b6';
    IF n <> 0 THEN RAISE EXCEPTION 'another tenant''s workflow run was reachable by dedupe key'; END IF;

    SELECT count(*) INTO n FROM "public"."workflow_references";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 workflow reference, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."workflow_references" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of workflow_references returned % rows', n; END IF;

    -- "Which workflows use this tag?" — the lookup the tag-delete path makes. Run
    -- with tenant B's tag id, it must find nothing: a tenant learning that another
    -- tenant's workflow uses a tag would be told about a rule they cannot see.
    SELECT count(*) INTO n FROM "public"."workflow_references"
        WHERE "tag_id" = '22222222-2222-7222-8222-2222222222c0';
    IF n <> 0 THEN RAISE EXCEPTION 'another tenant''s workflow reference was reachable by tag id'; END IF;

    SELECT count(*) INTO n FROM "public"."ticket_tags";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 ticket tag, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."ticket_tags" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of ticket_tags returned % rows', n; END IF;

    -- TAR-468's audit trail. `ticket_events` carries the reason an agent typed
    -- when they escalated or handed off — free text about a named colleague, and
    -- the most sensitive thing TAR-32 adds to the schema.
    SELECT count(*) INTO n FROM "public"."ticket_events";
    IF n <> 1 THEN RAISE EXCEPTION 'tenant A: expected 1 ticket event, saw %', n; END IF;

    SELECT count(*) INTO n FROM "public"."ticket_events" WHERE "tenant_id" = tenant_b;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant read of ticket_events returned % rows', n; END IF;

    SELECT count(*) INTO n FROM "public"."ticket_events"
        WHERE "data"->>'reason' = 'fixture B escalation reason';
    IF n <> 0 THEN RAISE EXCEPTION 'another tenant''s escalation reason was readable'; END IF;

    -- The escalation notification, by id — the read
    -- `GET /api/v1/escalation-alerts/{id}` and its acknowledge make. It must find
    -- nothing, so the endpoint answers 404 on the policy rather than on an
    -- application check that could be forgotten.
    SELECT count(*) INTO n FROM "public"."notifications"
        WHERE "id" = '22222222-2222-7222-8222-2222222222bf';
    IF n <> 0 THEN RAISE EXCEPTION 'another tenant''s escalation notification was reachable by id'; END IF;

    -- The recipient's own list query, unqualified by tenant exactly as the
    -- keyset-paged handler will issue it. Both fixture recipients are the *first*
    -- user in their tenant, so a policy that stopped filtering would show a
    -- supervisor another org's escalations under their own name.
    SELECT count(*) INTO n FROM "public"."notifications"
        WHERE "recipient_user_id" = '22222222-2222-7222-8222-2222222222b1';
    IF n <> 0 THEN RAISE EXCEPTION 'another tenant''s notification was reachable by recipient'; END IF;

    -- By the escalation's group key. This is the read that renders one escalation
    -- rather than three, and tenant B's event id must not resolve it.
    SELECT count(*) INTO n FROM "public"."notifications"
        WHERE "ticket_event_id" = '22222222-2222-7222-8222-2222222222be';
    IF n <> 0 THEN RAISE EXCEPTION 'another tenant''s escalation was reachable by ticket event id'; END IF;

    RAISE NOTICE 'ok: tenant A sees its own 23 rows and none of tenant B''s';

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

    -- The same thing on `sessions`, named separately because the consequence is
    -- different in kind: minting a session row inside another tenant is not a
    -- data leak, it is that tenant's account. Two mechanisms have to fail for
    -- this to succeed — the policy's WITH CHECK, and the composite foreign key
    -- to `users(tenant_id, id)`, which is why the fixture's own user id is used
    -- rather than tenant B's.
    BEGIN
        INSERT INTO "public"."sessions" ("id", "tenant_id", "user_id", "token_hash", "expires_at", "absolute_expires_at")
        VALUES ('11111111-1111-7111-8111-1111111111fe', tenant_b, '22222222-2222-7222-8222-2222222222b1',
                'tar54-forged-session-token-hash-not-a-real-token',
                now() + interval '12 hours', now() + interval '30 days');
        RAISE EXCEPTION 'minted a session inside another tenant — WITH CHECK is not enforcing';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'ok: session forged into another tenant rejected (SQLSTATE 42501)';
    END;

    -- TAR-468's composite foreign key, which is a *different* mechanism from the
    -- two above and is what the story's "enforced at the data layer, not left to
    -- application code alone" means. The row below is entirely legal as far as
    -- the policy is concerned: `tenant_id` is tenant A's own, so `WITH CHECK`
    -- passes. What refuses it is `(tenant_id, ticket_event_id)` finding no such
    -- pair in `ticket_events` — the path a handler that took an event id from a
    -- request body and forgot to scope the lookup would take. A foreign key
    -- violation, not an insufficient-privilege one, and the distinction is the
    -- point.
    BEGIN
        INSERT INTO "public"."notifications" ("id", "tenant_id", "type", "ticket_event_id", "ticket_id", "recipient_user_id")
        VALUES ('11111111-1111-7111-8111-1111111111fd', tenant_a, 'escalation',
                '22222222-2222-7222-8222-2222222222be', '11111111-1111-7111-8111-1111111111a6',
                '11111111-1111-7111-8111-1111111111a1');
        RAISE EXCEPTION 'notification referencing another tenant''s ticket event succeeded — the composite FK is not enforcing';
    EXCEPTION
        WHEN foreign_key_violation THEN
            RAISE NOTICE 'ok: escalation naming another tenant''s ticket event rejected (SQLSTATE 23503)';
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

    -- The `ticket_counters` version of the same thing, and the reason it is
    -- worth naming separately: its primary key *is* the tenant id, so reaching
    -- another tenant's row needs no id to leak first. Burning their ticket
    -- numbers would be a cheap nuisance if the policy were not there.
    UPDATE "public"."ticket_counters" SET "next_number" = 999999 WHERE "tenant_id" = tenant_b;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant UPDATE of ticket_counters modified % rows', n; END IF;

    -- Acknowledging another tenant's alert. The endpoint is a plain UPDATE by
    -- id, so if the policy did not filter it, one tenant's supervisor could
    -- silence another's — quietly, with no error and nothing in the audit log.
    UPDATE "public"."notifications" SET "acknowledged_at" = now()
        WHERE "id" = '22222222-2222-7222-8222-2222222222bd';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant acknowledge of a notification modified % rows', n; END IF;

    -- Disabling another tenant's workflow, or moving it in their rule list. Worse
    -- in kind than a read: automation a supervisor is relying on stops, and
    -- nothing anywhere says why.
    UPDATE "public"."workflows" SET "is_active" = false, "position" = 99
        WHERE "id" = '22222222-2222-7222-8222-2222222222c1';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant UPDATE of workflows modified % rows', n; END IF;

    -- Deleting another tenant's reference row, which is what would let *their*
    -- tag be deleted out from under a workflow that needs it.
    DELETE FROM "public"."workflow_references" WHERE "tenant_id" = tenant_b;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant DELETE of workflow_references removed % rows', n; END IF;

    -- The same shape on TAR-468's alert, and the same consequence: acknowledging
    -- another tenant's escalation would tell their supervisor a colleague had
    -- picked it up when nobody had.
    UPDATE "public"."notifications" SET "acknowledged_at" = now()
        WHERE "id" = '22222222-2222-7222-8222-2222222222bf';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant acknowledge of an escalation modified % rows', n; END IF;

    -- `ticket_events` is append-only by intent rather than by trigger, so the
    -- thing worth asserting is that the trail cannot be *edited* across the
    -- boundary. Rewriting the reason on somebody else's escalation would be an
    -- undetectable change to an audit record.
    UPDATE "public"."ticket_events" SET "data" = '{"reason": "rewritten"}'::jsonb
        WHERE "tenant_id" = tenant_b;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant UPDATE of ticket_events modified % rows', n; END IF;

    RAISE NOTICE 'ok: cross-tenant UPDATE and DELETE match 0 rows';

    -- 3f. The reset path. This is the empty-string case the NULLIF in the
    -- policy exists for; without it this raises a cast error instead of
    -- returning nothing.
    PERFORM set_config('app.tenant_id', '', false);

    SELECT count(*) INTO n FROM "public"."contacts";
    IF n <> 0 THEN RAISE EXCEPTION 'GUC reset to empty string exposed % contacts', n; END IF;

    RAISE NOTICE 'ok: GUC cleared to the empty string -> 0 rows';

    -- 3g. `webhook_events`, `webhook_event_replays`, `tenant_signups` and
    -- `lifecycle_events` carry no policy by design, so on all four the grant is
    -- the enforcement. The app role must not be able to read any of them at all.
    --
    -- Asserted here rather than left to phase 1b, which only proves the negative
    -- — "no privilege on an unprotected table" also passes for a table that was
    -- never created. These four are named, so a grant added by hand or an
    -- `app-roles.sql` branch dropped in a refactor fails by name.
    BEGIN
        EXECUTE 'SELECT count(*) FROM "public"."webhook_events"';
        RAISE EXCEPTION 'app role can read webhook_events — it holds no policy and must hold no grant';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'ok: webhook_events unreachable by the app role (no grant)';
    END;

    -- TAR-94. The operator replay trail for the table above, and unreachable
    -- for the same reason: a parked event may name no tenant, so no policy could
    -- apply and the grant is what stands in for one. Withholding UPDATE and
    -- DELETE from `whatsappcrm_system` as well is asserted by 3i below.
    BEGIN
        EXECUTE 'SELECT count(*) FROM "public"."webhook_event_replays"';
        RAISE EXCEPTION 'app role can read webhook_event_replays — it holds no policy and must hold no grant';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'ok: webhook_event_replays unreachable by the app role (no grant)';
    END;

    -- TAR-440. A signup row exists before its tenant does and holds an argon2id
    -- password hash plus a verification digest for an account nobody owns yet.
    -- It is reachable by `SystemPrisma` alone.
    BEGIN
        EXECUTE 'SELECT count(*) FROM "public"."tenant_signups"';
        RAISE EXCEPTION 'app role can read tenant_signups — it holds no policy and must hold no grant';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'ok: tenant_signups unreachable by the app role (no grant)';
    END;

    -- ADR 0009 Amendment 1 ruling 2. This one is the newest and the easiest to
    -- get wrong, because unlike the two above it *does* carry `tenant_id`: it
    -- looks scoped and is not. Dropping the policy without dropping the grant
    -- would have left every tenant's lifecycle history readable on the tenant
    -- connection, and nothing else in this file would have caught it — 1a skips
    -- the table by name and 1b only sees a table with no privilege.
    BEGIN
        EXECUTE 'SELECT count(*) FROM "public"."lifecycle_events"';
        RAISE EXCEPTION 'app role can read lifecycle_events — it holds no policy and must hold no grant';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'ok: lifecycle_events unreachable by the app role (no grant)';
    END;

    -- 3i. The append-only trails stay append-only for `whatsappcrm_system` too
    -- (TAR-403, TAR-94). Both tables are the record of an operator acting on
    -- production state, and `SystemPrisma` is the credential a mistake would run
    -- under — so the grant withholds UPDATE and DELETE from it, and a re-run of
    -- `app-roles.sql` that lost that branch has to fail here rather than in a
    -- compliance review.
    --
    -- Read as privileges rather than attempted as statements: an UPDATE matching
    -- no rows succeeds, so executing one would prove nothing about a table this
    -- fixture leaves empty.
    FOREACH trail IN ARRAY ARRAY['lifecycle_events', 'webhook_event_replays'] LOOP
        FOREACH priv IN ARRAY ARRAY['UPDATE', 'DELETE'] LOOP
            IF has_table_privilege('whatsappcrm_system', format('"public".%I', trail), priv) THEN
                RAISE EXCEPTION 'system role holds % on %, which is append-only', priv, trail;
            END IF;
        END LOOP;
    END LOOP;

    RAISE NOTICE 'ok: the append-only trails withhold UPDATE and DELETE from the system role';

    -- 3j. The system role, with no GUC at all, sees both tenants. Proves the
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
-- TAR-27's four tables, before the tags, teams, tickets and workflows they point
-- at. `workflow_references` goes first and explicitly: its tag and team foreign
-- keys are `NO ACTION`, so a row here outliving its tag would refuse that tag's
-- delete at the end of the statement rather than cascading with it.
DELETE FROM "public"."workflow_references" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."workflow_runs" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."workflows" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."ticket_tags" WHERE "tenant_id" = :'tenant_a';
-- TAR-270's three tables, before the ticket they hang off. They cascade from
-- `tickets`, so this is belt and braces — but notifications before timers before
-- policies is the order their own foreign keys require. The table was
-- `sla_alerts` until TAR-394 renamed it (0009, decision 7).
DELETE FROM "public"."notifications" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."sla_timers" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."sla_policies" WHERE "tenant_id" = :'tenant_a';
-- TAR-468's events, after the notifications above that reference them.
DELETE FROM "public"."ticket_events" WHERE "tenant_id" = :'tenant_a';
-- Before the conversation and contact they reference: those foreign keys are
-- NoAction, so the parents cannot go first.
DELETE FROM "public"."tickets" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."ticket_counters" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."conversations" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."contacts" WHERE "tenant_id" = :'tenant_a';
-- After `contact_tags` (which the contact above cascades), `ticket_tags` and
-- `workflow_references` — the first two cascade from the tag, the third refuses it.
DELETE FROM "public"."tags" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."whatsapp_accounts" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."whatsapp_business_accounts" WHERE "tenant_id" = :'tenant_a';
-- TAR-54's tables, before the users, invites and teams they hang off. Their
-- foreign keys cascade, so this is belt and braces — but every delete in this
-- block is explicit and tenant-qualified, and a cascade that quietly stops
-- being one should surface here rather than as a stray row later.
DELETE FROM "public"."password_reset_tokens" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."sessions" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."invite_teams" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."invites" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."teams" WHERE "tenant_id" = :'tenant_a';
DELETE FROM "public"."users" WHERE "tenant_id" = :'tenant_a';

SET LOCAL app.tenant_id = :'tenant_b';
DELETE FROM "public"."messages" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."workflow_references" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."workflow_runs" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."workflows" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."ticket_tags" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."notifications" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."sla_timers" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."sla_policies" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."ticket_events" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."tickets" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."ticket_counters" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."conversations" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."contacts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."tags" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."whatsapp_accounts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."whatsapp_business_accounts" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."password_reset_tokens" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."sessions" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."invite_teams" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."invites" WHERE "tenant_id" = :'tenant_b';
DELETE FROM "public"."teams" WHERE "tenant_id" = :'tenant_b';
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

    SELECT count(*) INTO n FROM "public"."ticket_counters" WHERE "tenant_id" IN (tenant_a, tenant_b);
    IF n <> 0 THEN RAISE EXCEPTION 'fixture ticket counters survived cleanup: %', n; END IF;

    SELECT count(*) INTO n FROM "public"."notifications" WHERE "tenant_id" IN (tenant_a, tenant_b);
    IF n <> 0 THEN RAISE EXCEPTION 'fixture notifications survived cleanup: %', n; END IF;

    -- The four TAR-27 tables, checked together: `workflow_references` is the one
    -- whose survival would be actively harmful, because its `NO ACTION` foreign
    -- keys would then refuse a later run's attempt to delete the fixture tag.
    SELECT count(*) INTO n FROM "public"."workflow_references" WHERE "tenant_id" IN (tenant_a, tenant_b);
    IF n <> 0 THEN RAISE EXCEPTION 'fixture workflow references survived cleanup: %', n; END IF;

    SELECT count(*) INTO n FROM "public"."workflow_runs" WHERE "tenant_id" IN (tenant_a, tenant_b);
    IF n <> 0 THEN RAISE EXCEPTION 'fixture workflow runs survived cleanup: %', n; END IF;

    SELECT count(*) INTO n FROM "public"."workflows" WHERE "tenant_id" IN (tenant_a, tenant_b);
    IF n <> 0 THEN RAISE EXCEPTION 'fixture workflows survived cleanup: %', n; END IF;

    SELECT count(*) INTO n FROM "public"."ticket_tags" WHERE "tenant_id" IN (tenant_a, tenant_b);
    IF n <> 0 THEN RAISE EXCEPTION 'fixture ticket tags survived cleanup: %', n; END IF;

    SELECT count(*) INTO n FROM "public"."tags" WHERE "tenant_id" IN (tenant_a, tenant_b);
    IF n <> 0 THEN RAISE EXCEPTION 'fixture tags survived cleanup: %', n; END IF;

    SELECT count(*) INTO n FROM "public"."notifications"
        WHERE "tenant_id" IN (tenant_a, tenant_b) AND "type" = 'escalation';
    IF n <> 0 THEN RAISE EXCEPTION 'fixture escalation notifications survived cleanup: %', n; END IF;

    SELECT count(*) INTO n FROM "public"."ticket_events" WHERE "tenant_id" IN (tenant_a, tenant_b);
    IF n <> 0 THEN RAISE EXCEPTION 'fixture ticket events survived cleanup: %', n; END IF;

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
