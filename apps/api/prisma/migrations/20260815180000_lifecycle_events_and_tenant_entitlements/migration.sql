-- ADR 0009 Amendment 1, rulings 2 and 3 — the rest of phase 2a′ (TAR-413).
--
-- `20260815160000` and `20260815170000` carried the four items the review found
-- missing. Amendment 1 landed between the review and that migration and ruled on
-- two more, both of which move a table this story already shipped:
--
--   Ruling 2  `lifecycle_audit_log` becomes `lifecycle_events`: platform-level,
--             no foreign keys, no `tenant_isolation` policy, `system-only` under
--             `TenantPrisma`. The append-only trigger and the `SELECT, INSERT`
--             grants stay exactly as they are.
--   Ruling 3  `tenant_plan_limits` becomes `tenant_entitlements`: `plan_key`,
--             `plan_name` and `entitlements jsonb` in `PlanEntitlementsSchema`'s
--             published shape. RLS-scoped, one row per tenant, unchanged in
--             every other respect.
--
-- It also corrects one line this story got wrong. `20260815170000` shipped
-- `assert_tenant_serviceable` with the pre-amendment allow-list; ruling 1 admits
-- `cancelled` as well. Section 3.
--
-- ---------------------------------------------------------------------------
-- Ruling 2 is not a naming change — the shipped shape cannot finish a purge
-- ---------------------------------------------------------------------------
--
-- `lifecycle_audit_log(tenant_id, actor_user_id) → users(tenant_id, id)` is
-- `ON DELETE NO ACTION`. The purge deletes every `users` row and keeps the
-- `tenants` row as the slug tombstone, so a retained lifecycle row carrying
-- `actor_user_id` is a referencing row that `DELETE FROM users` cannot pass —
-- SQLSTATE 23503. It cannot be repaired on the way past either: the append-only
-- trigger raises `TN002` on any UPDATE that is not the `notified_at` stamp, and
-- neither application role holds DELETE.
--
-- The flow that hits it is the one TAR-36 is mostly about — a tenant admin
-- deleting their own tenant writes `actor_type = 'user'`, which is the only
-- actor kind that fills that column. Reproduced before writing this file, on the
-- schema as it stands: the audit row blocks the delete, and every route around
-- it is closed by design.
--
-- ---------------------------------------------------------------------------
-- Dropping the policy without dropping the grant would be a leak
-- ---------------------------------------------------------------------------
--
-- Amendment 1 says the RLS half is inert — under ruling 1 the gate still refuses
-- `deleted`, so a purged tenant's trail was never readable through
-- `TenantPrisma` whatever policy sat on it. That is true of the *purged* case and
-- only of it. For a live tenant the policy is the only thing standing between
-- `whatsappcrm_app` and every other tenant's lifecycle history, because
-- `lifecycle_events` keeps its `tenant_id` column and the app role held
-- `SELECT, INSERT` on the table.
--
-- So the grant moves with the policy. `app-roles.sql` is amended in the same
-- commit: `whatsappcrm_system` keeps `SELECT, INSERT` and the column-level
-- `UPDATE (notified_at)`, and **`whatsappcrm_app` is granted nothing at all** —
-- the posture `webhook_events` and `tenant_signups` already carry, where the
-- grant rather than RLS is the enforcement. `LifecycleEvent` becomes
-- `system-only` in `tenant-scope.extension.ts` so a tenant-side call names the
-- cause instead of failing with SQLSTATE 42501, and
-- `verify-tenant-isolation.sql` gains the third named "unreachable by the app
-- role" assertion rather than relying on the negative test that also passes for
-- a table nobody created.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds on any realistic estate. Every statement is a
--                catalog update except the one backfill, which is sized by the
--                number of *tenants* — one `tenant_entitlements` row each.
--   Locks        ACCESS EXCLUSIVE on both tables for the renames and ALTERs, and
--                on `tenants` for the two index rebuilds in section 4. Held to
--                the end of the transaction as Prisma wraps the file in one, and
--                capped at three seconds by `lock_timeout`.
--   Blocking     `lifecycle_events` is written once per lifecycle transition and
--                read by one endpoint that does not exist yet, so its lock is
--                invisible. The `tenants` index rebuild blocks tenant-facing
--                requests for the milliseconds it takes; `lock_timeout` makes a
--                blocked migration abort rather than stack requests behind it.
--   Rewrite      One, and it is unavoidable: dropping `seat_cap` and
--                `conversation_cap` marks them dead rather than rewriting, but
--                `ALTER COLUMN ... SET NOT NULL` on `entitlements` scans the
--                table. One row per tenant.
--   Rollback     `down.sql` beside this file. Reversible, with two documented
--                losses named there.
--
-- ---------------------------------------------------------------------------
-- Re-run `pnpm db:roles` after applying this
-- ---------------------------------------------------------------------------
--
-- Both tables change name, and `app-roles.sql` keys its append-only branch on
-- the table name. Until it is re-run, `lifecycle_events` still carries the
-- app-role grant this migration's whole security argument depends on removing,
-- and `tenant_entitlements` — a renamed table, so its privileges came with it —
-- is reachable exactly as before. `pnpm db:verify:rls` fails by name in that
-- window, which is the intended way to find out.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. `lifecycle_audit_log` → `lifecycle_events`
-- ---------------------------------------------------------------------------

-- 1a. The foreign keys. `actor_user_id` is the one that blocks the purge;
-- `tenant_id` goes with it because ruling 2's alternative — dropping only the
-- first — leaves `ON DELETE CASCADE` from `tenants`, so any real
-- `DELETE FROM tenants` silently destroys the trail TAR-36's sixth acceptance
-- criterion asks us to keep. A fixture teardown is exactly such a delete.
--
-- What replaces them is nothing, deliberately. `tenant_id` and `actor_user_id`
-- become what decision 5 always specified: recorded identifiers that outlive the
-- rows they name. A trail whose integrity depends on the rows it describes still
-- existing is not a trail that survives a purge.
ALTER TABLE "public"."lifecycle_audit_log"
    DROP CONSTRAINT "lifecycle_audit_log_tenant_id_actor_user_id_fkey";

ALTER TABLE "public"."lifecycle_audit_log"
    DROP CONSTRAINT "lifecycle_audit_log_tenant_id_fkey";

-- 1b. Row-level security. `system_unrestricted` is `app-roles.sql`'s, dropped
-- here so re-running that file after this migration is a no-op rather than a
-- resurrection; it is `IF EXISTS` because a database that never ran that file
-- does not carry it.
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."lifecycle_audit_log";
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."lifecycle_audit_log";

ALTER TABLE "public"."lifecycle_audit_log" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."lifecycle_audit_log" DISABLE ROW LEVEL SECURITY;

-- 1c. The rename itself. `ALTER TABLE ... RENAME` moves the table and its
-- composite type and nothing else — every index, constraint and trigger keeps
-- the name it was created with, and a schema where `lifecycle_events` is held up
-- by `lifecycle_audit_log_pkey` is a schema nobody can grep. Each is renamed
-- explicitly.
ALTER TABLE "public"."lifecycle_audit_log" RENAME TO "lifecycle_events";

ALTER INDEX "public"."lifecycle_audit_log_pkey"
    RENAME TO "lifecycle_events_pkey";
ALTER INDEX "public"."lifecycle_audit_log_tenant_id_occurred_at_id_idx"
    RENAME TO "lifecycle_events_tenant_id_occurred_at_id_idx";
ALTER INDEX "public"."lifecycle_audit_log_notified_at_pending_idx"
    RENAME TO "lifecycle_events_notified_at_pending_idx";

ALTER TABLE "public"."lifecycle_events"
    RENAME CONSTRAINT "lifecycle_audit_log_actor_attribution"
    TO "lifecycle_events_actor_attribution";

ALTER TABLE "public"."lifecycle_events"
    RENAME CONSTRAINT "lifecycle_audit_log_transition_changes_state"
    TO "lifecycle_events_transition_changes_state";

-- 1d. The append-only trigger, recreated rather than renamed.
--
-- `ALTER TRIGGER ... RENAME TO` would move the trigger, but the function it
-- calls declares `probe "public"."lifecycle_audit_log"` — a composite type
-- reference resolved when the body runs, not when it is created. The rename in
-- 1c moved that type, so the old body would raise `42704: type
-- "public"."lifecycle_audit_log" does not exist` on the first UPDATE after this
-- migration, and the first UPDATE after this migration is a notification stamp
-- in production rather than anything a test would reach first.
--
-- The logic is unchanged from `20260815160000` and the reasoning there still
-- applies in full: the one permitted update is a null-to-value `notified_at`
-- stamp with every other column byte-identical, established by comparing the two
-- rows rather than trusting the `SET` list, so a column added by a later
-- migration is covered on the day it is added.
DROP TRIGGER "lifecycle_audit_log_append_only" ON "public"."lifecycle_events";
DROP FUNCTION "public"."lifecycle_audit_log_forbid_update"();

CREATE FUNCTION "public"."lifecycle_events_forbid_update"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    probe "public"."lifecycle_events";
BEGIN
    IF OLD."notified_at" IS NULL AND NEW."notified_at" IS NOT NULL THEN
        probe := NEW;
        probe."notified_at" := OLD."notified_at";

        IF probe IS NOT DISTINCT FROM OLD THEN
            RETURN NEW;
        END IF;
    END IF;

    RAISE EXCEPTION 'lifecycle_events is append-only: row % cannot be updated', OLD."id"
        USING ERRCODE = 'TN002',
              HINT = 'Only notified_at may be UPDATEd, once, from NULL. Record a correction as a '
                     'new transition instead of editing the old one.';
END;
$$;

COMMENT ON FUNCTION "public"."lifecycle_events_forbid_update"() IS
    'TAR-403, narrowed by TAR-413 and renamed with its table by ADR 0009 Amendment 1 ruling 2. '
    'Raises TN002 on any UPDATE of lifecycle_events, including by the table owner, with one '
    'exception: stamping notified_at from NULL to a value while every other column stays '
    'identical. DELETE is intentionally not blocked — with the foreign keys gone there is no '
    'cascade left to reach these rows, and the grants withhold it from both application roles.';

CREATE TRIGGER "lifecycle_events_append_only"
    BEFORE UPDATE ON "public"."lifecycle_events"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."lifecycle_events_forbid_update"();

COMMENT ON TABLE "public"."lifecycle_events" IS
    'TAR-403, moved to platform level by ADR 0009 Amendment 1 ruling 2. Append-only, one row per '
    'tenant lifecycle transition. No foreign keys and no RLS policy: it outlives the rows it '
    'names, and the composite FK to users made the purge impossible to finish (23503). tenant_id '
    'and actor_user_id are recorded identifiers, not references. Reachable through SystemPrisma '
    'alone — the app role holds no grant, which is what replaces the policy.';

COMMENT ON COLUMN "public"."lifecycle_events"."tenant_id" IS
    'The tenant this transition belongs to. Deliberately NOT a foreign key (Amendment 1 ruling 2): '
    'the row survives the tenant''s purge, and a cascade from tenants would let a fixture teardown '
    'destroy the trail.';

COMMENT ON COLUMN "public"."lifecycle_events"."actor_user_id" IS
    'Who acted, when actor_type is `user`. Deliberately NOT a foreign key: the purge deletes every '
    'users row, and ON DELETE NO ACTION here blocked that delete with 23503 on any tenant that had '
    'ever acted on itself. The row is kept and the reference is not.';

-- ---------------------------------------------------------------------------
-- 2. `tenant_plan_limits` → `tenant_entitlements`
-- ---------------------------------------------------------------------------
--
-- TAR-403's argument for a per-tenant, RLS-scoped table is accepted in full by
-- ruling 3 and nothing about it changes here: `plans` is platform-wide and
-- carries no policy, reaching for it needs a `subscriptions` row per tenant, and
-- both belong to the story that owns billing. Only the width changes, so
-- `TenantLifecycleResponse.plan` maps from one row with no join.
--
-- The row is a **snapshot** of the catalogue rather than a pointer to it — a
-- tenant keeps what it was sold when the catalogue moves under it — and TAR-37's
-- plan sync becomes its writer.

-- 2a. The two new columns, nullable first because the backfill below has to read
-- the old ones to compute them.
ALTER TABLE "public"."tenant_plan_limits"
    ADD COLUMN "plan_name" TEXT,
    ADD COLUMN "entitlements" JSONB;

-- 2b. The backfill, and the rule it follows: **no existing tenant loses
-- anything.**
--
-- `seat_cap` and `conversation_cap` carry across as `seats` and
-- `conversationsPerPeriod` exactly. The three limits that have never existed —
-- `whatsappNumbers`, `teams`, `knowledgeDocuments` — are written as `null`,
-- which is unlimited, because nothing has ever enforced them and inventing a
-- ceiling here would be a migration quietly taking away capacity somebody is
-- already using. The same reasoning TAR-403 used to grandfather every existing
-- tenant as `unlimited` rather than onto the trial caps.
--
-- `features` follows the plan key. An `unlimited` row is one of TAR-403's
-- grandfathered operator-provisioned tenants, which was never sold a restricted
-- plan, so it gets the full set; anything else gets 0009's published trial pair.
-- Nothing reads `features` today — `@RequireFeature` is TAR-37's, at stage 6 —
-- so this is the shape being made correct rather than a capability changing, and
-- TAR-37's plan sync overwrites it with real catalogue data.
UPDATE "public"."tenant_plan_limits"
   SET "plan_name" = CASE "plan_key"
                         WHEN 'unlimited' THEN 'Unlimited'
                         WHEN 'trial' THEN 'Trial'
                         ELSE initcap(replace("plan_key", '_', ' '))
                     END,
       "entitlements" = jsonb_build_object(
           'features',
           CASE
               WHEN "plan_key" = 'unlimited' THEN
                   '["assignment_rules","sla_policies","workflows","ai_chatbot","custom_branding","custom_domain","advanced_reporting","api_access"]'::jsonb
               ELSE
                   '["assignment_rules","sla_policies"]'::jsonb
           END,
           'limits', jsonb_build_object(
               'seats', "seat_cap",
               'conversationsPerPeriod', "conversation_cap",
               'whatsappNumbers', NULL::int,
               'teams', NULL::int,
               'knowledgeDocuments', NULL::int
           )
       )
 WHERE "entitlements" IS NULL;

ALTER TABLE "public"."tenant_plan_limits"
    ALTER COLUMN "plan_name" SET NOT NULL,
    ALTER COLUMN "entitlements" SET NOT NULL;

-- Defaults, so provisioning inserts a row without restating the whole shape —
-- the same convenience `seat_cap`/`conversation_cap` carried, and the same
-- caveat: these are 0009's published trial figures, defensible rather than
-- measured, and TAR-397 owns the real ones. A column default is one `ALTER
-- TABLE` to revise rather than a hunt through application code.
ALTER TABLE "public"."tenant_plan_limits"
    ALTER COLUMN "plan_name" SET DEFAULT 'Trial';

ALTER TABLE "public"."tenant_plan_limits"
    ALTER COLUMN "entitlements" SET DEFAULT
        '{"features":["assignment_rules","sla_policies"],'
        '"limits":{"seats":3,"conversationsPerPeriod":1000,"whatsappNumbers":1,'
        '"teams":2,"knowledgeDocuments":10}}'::jsonb;

-- 2c. The old columns go, and `tenant_plan_limits_caps_positive` goes with them
-- — PostgreSQL drops a constraint when the last column it depends on is dropped.
-- Named explicitly first so the reversal has something to reinstate and so this
-- file does not rely on that behaviour silently.
ALTER TABLE "public"."tenant_plan_limits"
    DROP CONSTRAINT "tenant_plan_limits_caps_positive";

ALTER TABLE "public"."tenant_plan_limits"
    DROP COLUMN "seat_cap",
    DROP COLUMN "conversation_cap";

-- 2d. What replaces `caps_positive`, which is ruling 3's one named constraint:
-- "the five limit keys are present and each is null or a positive integer and
-- `features` is an array".
--
-- Written out per key rather than as a loop, because a CHECK may not contain a
-- subquery and `jsonb_each` is one. It is also the more useful failure: the
-- constraint name in the error names the table, and the reader of this file can
-- see which five keys are meant without running anything.
--
-- **`jsonb_exists` before every type test, and that is not belt-and-braces.**
-- `entitlements->'limits'->'seats'` on a missing key is SQL NULL, `jsonb_typeof`
-- of that is NULL, and a CHECK whose expression evaluates to NULL *passes*. A
-- row missing every limit would satisfy the type tests alone.
--
-- Positive-integer is tested as a regex on the text form rather than a cast:
-- `('...'->>'seats')::int > 0` raises `22P02` on `"three"` instead of failing
-- the constraint, and a constraint that errors on bad input rather than
-- rejecting the row reports the wrong thing to the application. `^[1-9][0-9]*$`
-- refuses zero, negatives, decimals and `1e3` in one expression.
--
-- The check is the backstop, not the contract. `PlanEntitlementsSchema` at every
-- write site is the contract — it is what validates the `features` *elements*
-- against `PLAN_FEATURES`, which SQL has no business restating.
-- Named for the table it is about to become, since a constraint name is free of
-- the table's own and this one has no reason to be renamed twice.
ALTER TABLE "public"."tenant_plan_limits"
    ADD CONSTRAINT "tenant_entitlements_shape" CHECK (
        jsonb_typeof("entitlements") = 'object'
        AND jsonb_typeof("entitlements" -> 'features') = 'array'
        AND jsonb_typeof("entitlements" -> 'limits') = 'object'

        AND jsonb_exists("entitlements" -> 'limits', 'seats')
        AND (jsonb_typeof("entitlements" -> 'limits' -> 'seats') = 'null'
             OR ("entitlements" -> 'limits' ->> 'seats') ~ '^[1-9][0-9]*$')

        AND jsonb_exists("entitlements" -> 'limits', 'conversationsPerPeriod')
        AND (jsonb_typeof("entitlements" -> 'limits' -> 'conversationsPerPeriod') = 'null'
             OR ("entitlements" -> 'limits' ->> 'conversationsPerPeriod') ~ '^[1-9][0-9]*$')

        AND jsonb_exists("entitlements" -> 'limits', 'whatsappNumbers')
        AND (jsonb_typeof("entitlements" -> 'limits' -> 'whatsappNumbers') = 'null'
             OR ("entitlements" -> 'limits' ->> 'whatsappNumbers') ~ '^[1-9][0-9]*$')

        AND jsonb_exists("entitlements" -> 'limits', 'teams')
        AND (jsonb_typeof("entitlements" -> 'limits' -> 'teams') = 'null'
             OR ("entitlements" -> 'limits' ->> 'teams') ~ '^[1-9][0-9]*$')

        AND jsonb_exists("entitlements" -> 'limits', 'knowledgeDocuments')
        AND (jsonb_typeof("entitlements" -> 'limits' -> 'knowledgeDocuments') = 'null'
             OR ("entitlements" -> 'limits' ->> 'knowledgeDocuments') ~ '^[1-9][0-9]*$')
    );

-- 2e. The rename, and every object name that does not follow it on its own.
ALTER TABLE "public"."tenant_plan_limits" RENAME TO "tenant_entitlements";

ALTER INDEX "public"."tenant_plan_limits_pkey"
    RENAME TO "tenant_entitlements_pkey";
ALTER INDEX "public"."tenant_plan_limits_tenant_id_key"
    RENAME TO "tenant_entitlements_tenant_id_key";

ALTER TABLE "public"."tenant_entitlements"
    RENAME CONSTRAINT "tenant_plan_limits_tenant_id_fkey"
    TO "tenant_entitlements_tenant_id_fkey";

ALTER TABLE "public"."tenant_entitlements"
    RENAME CONSTRAINT "tenant_plan_limits_plan_key_format"
    TO "tenant_entitlements_plan_key_format";

COMMENT ON TABLE "public"."tenant_entitlements" IS
    'TAR-403, widened and renamed by ADR 0009 Amendment 1 ruling 3. The tenant''s effective '
    'entitlements, one row per tenant, in PlanEntitlementsSchema''s published shape. A snapshot of '
    'the catalogue rather than a pointer to it, so a tenant keeps what it was sold; TAR-37''s plan '
    'sync becomes the writer. Enforcement and display read this same row — that is the point.';

COMMENT ON COLUMN "public"."tenant_entitlements"."plan_name" IS
    'Display name for plan_key, so TenantLifecycleResponse.plan maps from one row with no join.';

COMMENT ON COLUMN "public"."tenant_entitlements"."entitlements" IS
    'PlanEntitlementsSchema: { features: PlanFeature[], limits: { seats, conversationsPerPeriod, '
    'whatsappNumbers, teams, knowledgeDocuments } }. NULL limit = unlimited, deliberately not -1. '
    'tenant_entitlements_shape is the backstop; the Zod schema at each write site is the contract.';

-- ---------------------------------------------------------------------------
-- 3. `assert_tenant_serviceable` admits `cancelled` (ruling 1)
-- ---------------------------------------------------------------------------
--
-- `20260815170000` shipped the allow-list 0009 published before it was amended.
-- Ruling 1 adds `cancelled`, and the evidence is that without it the seven-day
-- undo window cannot work: the recovery allowlist gives a cancelled tenant's
-- admin `POST /auth/login`, `GET /auth/session`, `GET /tenant`,
-- `GET /tenant/lifecycle` and `GET /billing/*`, and `identity/auth.service.ts`
-- and `identity/session.service.ts` both inject `TENANT_PRISMA` — so every one
-- of those routes would raise `TN001` before reaching the guard that is supposed
-- to allow it.
--
-- **The rule, stated once: the database gate refuses `created` and `deleted`,
-- and nothing else.** It answers whether this tenant's data exists and is
-- intact. Provisioning has not finished, or the data is gone — those are the two
-- states where the answer is no. Every question about who may do what in a given
-- state is `TenantStatusGuard`'s at stage 4, and neither gate carries a copy of
-- the other's policy.
--
-- Still safe to apply on its own: the function has no callers until TAR-404's
-- engine repoints `tenant-scope.extension.ts`, which still calls
-- `assert_tenant_active`. `CREATE OR REPLACE`, so the `EXECUTE` grants
-- `app-roles.sql` made are undisturbed.
CREATE OR REPLACE FUNCTION "public"."assert_tenant_serviceable"(tenant_id text)
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
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: no tenant id was supplied'
            USING ERRCODE = 'TN001';
    END IF;

    IF tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        -- Refused as this function's own error rather than left to the cast, so
        -- the application reports it as the refusal it is.
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: tenant id % is not a uuid', tenant_id
            USING ERRCODE = 'TN001';
    END IF;

    SELECT t."status" INTO current_status
    FROM "public"."tenants" t
    WHERE t."id" = tenant_id::uuid;

    IF NOT FOUND THEN
        -- A tenant row that was erased outright, or an id from a session issued
        -- against another database. Same answer as a refused one: the caller
        -- learns nothing about which it was.
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: tenant % does not exist', tenant_id
            USING ERRCODE = 'TN001';
    END IF;

    -- Still an allow-list and not a deny-list: a label added to `tenant_status`
    -- by a later migration is refused until somebody decides it should not be.
    IF current_status <> ALL (
        ARRAY['trialing', 'active', 'past_due', 'suspended', 'cancelled']::"public"."tenant_status"[]
    ) THEN
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: tenant % is %', tenant_id, current_status
            USING ERRCODE = 'TN001';
    END IF;

    RETURN tenant_id;
END;
$$;

COMMENT ON FUNCTION "public"."assert_tenant_serviceable"(text) IS
    'ADR 0009 decision 2 as amended by Amendment 1 ruling 1. Returns the tenant id when that '
    'tenant''s data exists and is intact — trialing, active, past_due, suspended or cancelled — '
    'and raises TN001 for created (provisioning unfinished) and deleted (a tombstone). Replaces '
    'assert_tenant_active as TenantPrisma''s gate. `suspended` is admitted so inbound WhatsApp '
    'messages are still stored; `cancelled` is admitted so the recovery allowlist that undoes a '
    'cancellation can reach the database at all. Which principal may reach which route is '
    'TenantStatusGuard''s question at stage 4, not this function''s.';

-- ---------------------------------------------------------------------------
-- 4. The sweeper indexes pick up their `status` predicates
-- ---------------------------------------------------------------------------
--
-- Phase 2a′ asks for 0009 lines 577–580, which predicate on the status the sweep
-- actually scans rather than on `IS NOT NULL` alone.
--
-- **This narrows what the index can answer, and the sweep queries have to be
-- written to match.** A partial index is only usable when the planner can prove
-- the query's `WHERE` implies the index predicate, so TAR-404's sweep must state
-- the status alongside the timer:
--
--     -- uses tenants_grace_due
--     WHERE status IN ('past_due','cancelled') AND grace_period_ends_at <= now()
--     -- uses tenants_purge_due
--     WHERE status = 'suspended' AND purge_at <= now() AND deleted_at IS NULL
--
-- A sweep that filters on the timer alone gets a sequential scan instead, and on
-- a table this small it will not be slow enough to notice. That is the trade
-- Amendment 1 accepts in exchange for indexes that hold only rows the sweep can
-- act on; it is recorded here because the failure mode is silent.
--
-- Names follow 0009's rather than the columns, since the predicate is now the
-- larger half of what each index is.
DROP INDEX "public"."tenants_grace_period_ends_at_idx";
DROP INDEX "public"."tenants_purge_at_idx";

CREATE INDEX "tenants_grace_due" ON "public"."tenants"("grace_period_ends_at")
    WHERE "status" IN ('past_due', 'cancelled') AND "grace_period_ends_at" IS NOT NULL;

CREATE INDEX "tenants_purge_due" ON "public"."tenants"("purge_at")
    WHERE "status" = 'suspended' AND "purge_at" IS NOT NULL;
