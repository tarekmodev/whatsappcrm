-- Tenant lifecycle: retention timers, the audit trail, and the trial-plan limit
-- config (TAR-403, 2 of 2).
--
-- `20260815120000_tenant_lifecycle_status_vocabulary` put the vocabulary in
-- place. This migration builds the three things the lifecycle engine (TAR-404)
-- and signup (TAR-405) read and write against it:
--
--   1. `tenants.grace_period_ends_at` / `purge_at` / `cancelled_at` /
--      `deleted_at` — the retention timers.
--   2. `lifecycle_audit_log` — append-only, one row per transition.
--   3. `tenant_plan_limits` — the DB-backed trial-plan limit config TAR-405
--      enforces at write time and TAR-37 later fills from real plan data.
--
-- It is a separate migration directory from the vocabulary because PostgreSQL
-- forbids *using* an enum value in the transaction that added it, and the
-- constraints and backfills below reference `deleted` and `trialing`.
--
-- ---------------------------------------------------------------------------
-- Durations live in the contract; instants live here
-- ---------------------------------------------------------------------------
--
-- TAR-397 fixes the grace-period and retention *lengths* — how long after
-- cancellation before suspension, how long after suspension before purge. This
-- schema stores neither. It stores the absolute instant each timer expires, so
-- the columns match whatever values TAR-397 publishes without a migration, and
-- a change to a published duration cannot silently reinterpret a timer already
-- running for a live tenant.
--
-- No column here carries a default duration, and nothing in this file computes
-- one. TAR-404 sets these instants from the published constants.
--
-- ---------------------------------------------------------------------------
-- What "hard-delete" leaves behind
-- ---------------------------------------------------------------------------
--
-- The `deleted` state is a **tombstone**: the `tenants` row survives the purge
-- holding `status = 'deleted'` and `deleted_at`, and its `lifecycle_audit_log`
-- rows survive with it. That is what makes the trail permanent, and it is why
-- the audit log's foreign key is `ON DELETE CASCADE` like every other child of
-- `tenants` rather than something that would refuse the delete: a physical
-- `DELETE FROM tenants` is a fixture teardown and an erasure-request operation
-- — the seed and every integration test do it — and it is *not* the lifecycle's
-- hard-delete. Conflating them would either break the test suite or leave the
-- trail deletable by accident, and the tombstone avoids both.
--
-- TAR-397 owns the purge scope. If it decides the `tenants` row itself must go,
-- the audit trail needs a different home than a child table of `tenants`, and
-- that is a schema change to make deliberately rather than a default to
-- discover.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Four nullable `ADD COLUMN`s are catalog-only
--                (PostgreSQL 11+ never rewrites for a nullable column with no
--                default). The two index builds and the two backfills are sized
--                by the number of *tenants*, which is the customer count — tens
--                to thousands, not a row count that grows with traffic. This is
--                the one table in the schema where a non-concurrent index build
--                needs no argument.
--   Locks        ACCESS EXCLUSIVE on `tenants` for the ALTER and the index
--                builds, held to the end of the transaction as Prisma wraps the
--                whole file in one. Capped at three seconds by `lock_timeout`.
--                The two new tables lock nothing anyone else can see.
--   Blocking     A tenant-facing request that touches `tenants` — which is every
--                request, through `assert_tenant_active` — queues behind the
--                ALTER for the duration. That duration is milliseconds, and the
--                `lock_timeout` makes a blocked migration abort rather than
--                stack requests behind it.
--   Rewrite      None. Confirmed by the column list: every added column is
--                nullable with no default.
--   Rollback     `down.sql` beside this file. Reversible with one documented
--                loss, named there.
--
-- ---------------------------------------------------------------------------
-- Re-run `pnpm db:roles` after applying this
-- ---------------------------------------------------------------------------
--
-- Two new tables. `app-roles.sql` grants them to the application roles and
-- attaches their `system_unrestricted` policy; until it is re-run,
-- `whatsappcrm_app` holds no privilege on either (TAR-95 — the grant waits for
-- the policy, deliberately), and `pnpm db:verify:rls` fails by name.
--
-- `app-roles.sql` is amended in the same commit: `lifecycle_audit_log` is
-- append-only, so it is the first table in the schema that gets `SELECT, INSERT`
-- and not `UPDATE, DELETE`.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Retention timers on `tenants`
-- ---------------------------------------------------------------------------

ALTER TABLE "tenants"
    ADD COLUMN "cancelled_at" TIMESTAMPTZ(3),
    ADD COLUMN "grace_period_ends_at" TIMESTAMPTZ(3),
    ADD COLUMN "purge_at" TIMESTAMPTZ(3),
    ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN "tenants"."cancelled_at" IS
    'TAR-403. When the tenant last entered `cancelled`. Retained through a reactivation '
    '(cancelled → active is a legal transition) so support can answer "when did they leave".';

COMMENT ON COLUMN "tenants"."grace_period_ends_at" IS
    'TAR-403. When the grace period currently running expires, after which the retention '
    'sweeper moves the tenant on. NULL when no timer is running. The length comes from '
    'TAR-397''s published constants; only the instant is stored.';

COMMENT ON COLUMN "tenants"."purge_at" IS
    'TAR-403. The earliest instant hard-delete may run for this tenant. NULL until the '
    'retention window starts. Nothing purges before this passes.';

COMMENT ON COLUMN "tenants"."deleted_at" IS
    'TAR-403. When the purge ran. The row itself survives as a tombstone holding '
    'status = ''deleted'', which is what keeps lifecycle_audit_log permanent.';

-- `deleted` and `deleted_at` are one fact spelled two ways, so they are made to
-- agree. A biconditional rather than a one-way implication: a tenant reported as
-- deleted with no purge timestamp is as wrong as a purge timestamp on a live
-- tenant, and the second is the one that would let a reactivation quietly
-- resurrect purged data.
--
-- Nothing constrains `grace_period_ends_at` or `purge_at` against `status`. They
-- are timer slots, and which states may carry a running timer is TAR-397's
-- state machine rather than a schema invariant — pinning it here would make a
-- contract revision a migration.
--
-- Prisma's schema language has no syntax for CHECK, so this lives in SQL. Its
-- Postgres describer ignores check constraints, so `migrate dev` proposes
-- neither to create nor to drop it and this is not drift — the same arrangement
-- `audit_logs_actor_attribution` documents. Nothing regenerates it from
-- `schema.prisma` alone.
ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_deleted_at_matches_status" CHECK (
        ("status" = 'deleted') = ("deleted_at" IS NOT NULL)
    );

-- The retention sweeper's two queries: "whose grace period has expired" and
-- "who is due to be purged", both cross-tenant, both run from a worker with no
-- request context and therefore no tenant term — the same shape as
-- `sla_timers_state_due_at_idx` (0006).
--
-- Partial, and that is what makes them nearly free: a tenant with no timer
-- running is not in the index at all, so both indexes hold one entry per tenant
-- *currently in a grace or retention window* — a handful of rows on any
-- realistic estate — and an INSERT or UPDATE that leaves the column NULL does
-- not touch them.
--
-- Predicated indexes cannot be expressed in `schema.prisma` either, and Prisma's
-- describer ignores them for the same reason it ignores the CHECK above; the
-- indexes on `users` and `tickets` are the precedent.
CREATE INDEX "tenants_grace_period_ends_at_idx" ON "tenants"("grace_period_ends_at")
    WHERE "grace_period_ends_at" IS NOT NULL;

CREATE INDEX "tenants_purge_at_idx" ON "tenants"("purge_at")
    WHERE "purge_at" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. `lifecycle_audit_log`
-- ---------------------------------------------------------------------------
--
-- Separate from `audit_logs` rather than a set of actions inside it, for three
-- reasons that all point the same way:
--
--   * It answers one question — "what state was this tenant in, when, and who
--     moved it" — with typed `from_state` / `to_state` columns an `audit_logs`
--     row could only carry inside its free-form `metadata` JSON. A state machine
--     whose history is untyped JSON cannot be reconstructed by a query.
--   * It is append-only for real (below), where `audit_logs` is append-only by
--     convention.
--   * It has a different retention rule: it outlives the tenant's data.
--
-- `actor_type` / `actor_user_id` / `actor_label` are TAR-166's attribution
-- triple, copied deliberately so support tooling reads one vocabulary across
-- both tables. Unlike `audit_logs`, `actor_type` carries **no default**: there
-- is no rollout window for a table that starts empty, so every writer states who
-- acted or the insert fails.
CREATE TABLE "lifecycle_audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_user_id" UUID,
    "actor_label" TEXT,
    "from_state" "tenant_status",
    "to_state" "tenant_status" NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,

    CONSTRAINT "lifecycle_audit_log_pkey" PRIMARY KEY ("id")
);

-- The read endpoint: this tenant's history, newest first. `(created_at DESC,
-- id DESC)` is the schema's keyset-pagination shape (0002, rule 3) with
-- `occurred_at` in the timestamp's place, and a UUIDv7 id is the tie-breaker for
-- two transitions written in the same millisecond.
--
-- The only index on the table, on purpose. `(tenant_id, actor_user_id)` would
-- mirror `audit_logs`, but a tenant accumulates a handful of lifecycle rows over
-- its whole life — the index would never be cheaper than the scan it replaced,
-- and it would cost a write on every transition.
CREATE INDEX "lifecycle_audit_log_tenant_id_occurred_at_id_idx"
    ON "lifecycle_audit_log"("tenant_id", "occurred_at" DESC, "id" DESC);

ALTER TABLE "lifecycle_audit_log"
    ADD CONSTRAINT "lifecycle_audit_log_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite, against `users(tenant_id, id)` — never `users(id)` alone (0002,
-- convention 2). `NO ACTION` because a user is removed by a status change and
-- never deleted, and because a `DELETE FROM tenants` cascade must not be aborted
-- by a reference it is about to remove anyway.
ALTER TABLE "lifecycle_audit_log"
    ADD CONSTRAINT "lifecycle_audit_log_tenant_id_actor_user_id_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "users"("tenant_id", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The attribution triple has to agree with itself, exactly as in
-- `audit_logs_actor_attribution`: a `user` row names a user and carries no
-- label, a `platform_operator` row carries a label and names no user, a `system`
-- row carries neither.
--
-- `unattributed` is looser here for one reason only — the backfill below writes
-- it, because the state each existing tenant is already in was reached before
-- this table existed and nothing recorded who did it. Application code writes
-- from `AuditActorType` in `src/audit/audit-actor.ts`, which does not include
-- it.
ALTER TABLE "lifecycle_audit_log"
    ADD CONSTRAINT "lifecycle_audit_log_actor_attribution" CHECK (
        CASE "actor_type"
            WHEN 'user' THEN "actor_user_id" IS NOT NULL AND "actor_label" IS NULL
            WHEN 'platform_operator' THEN "actor_user_id" IS NULL AND "actor_label" IS NOT NULL
            WHEN 'system' THEN "actor_user_id" IS NULL AND "actor_label" IS NULL
            ELSE "actor_user_id" IS NULL AND "actor_label" IS NULL
        END
    );

-- A transition that does not change the state is not a transition. `from_state`
-- is NULL for the first row of a tenant's history — its creation, and the
-- backfilled genesis rows below — which is the one case with nothing to differ
-- from.
ALTER TABLE "lifecycle_audit_log"
    ADD CONSTRAINT "lifecycle_audit_log_transition_changes_state" CHECK (
        "from_state" IS NULL OR "from_state" <> "to_state"
    );

COMMENT ON TABLE "lifecycle_audit_log" IS
    'TAR-403. Append-only, one row per tenant lifecycle transition. Survives hard-delete: the '
    'tenants row remains as a tombstone in status = ''deleted'' and these rows remain with it.';

-- ---------------------------------------------------------------------------
-- 3. `tenant_plan_limits`
-- ---------------------------------------------------------------------------
--
-- The placeholder plan-limits config TAR-405 enforces at write time, and the
-- swap point for TAR-37.
--
-- **Why per tenant and not per plan.** `plans.entitlements` is the plan
-- catalogue, and it is TAR-37's — a story still in `backlog`, whose table is
-- populated today only by the demo seed. Reaching for it would mean fixing its
-- JSON shape and requiring a `subscriptions` row per tenant, both of which are
-- decisions belonging to the story that owns billing. It is also platform-wide
-- and therefore not RLS-protected, while the enforcement TAR-405 needs runs on
-- the tenant connection.
--
-- So this table holds the tenant's **effective** limits — the only thing
-- enforcement reads. When TAR-37 lands, its plan sync becomes this table's
-- writer and `plan_key` starts naming a real plan; the shape enforcement reads
-- does not change, which is what TAR-397 asks for.
--
-- **Why not columns on `tenant_settings`.** That table's own comment invites
-- feature stories to add columns rather than invent a second settings table, and
-- this is the case it should not cover: `tenant_settings` is edited by the
-- tenant's own admins, and a seat cap the capped party can raise is not a cap.
-- A separate table is a separate grant.
--
-- `NULL` means unlimited, deliberately not `-1` or a sentinel maximum — the
-- convention `PlanLimitsSchema` already publishes, and both of the alternatives
-- invite arithmetic bugs at the comparison site.
CREATE TABLE "tenant_plan_limits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_key" TEXT NOT NULL DEFAULT 'trial',
    "seat_cap" INTEGER DEFAULT 3,
    "conversation_cap" INTEGER DEFAULT 1000,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_plan_limits_pkey" PRIMARY KEY ("id")
);

-- One row per tenant. The uniqueness is the point: two rows would be two answers
-- to "what may this tenant do", and the enforcement site has no way to choose.
CREATE UNIQUE INDEX "tenant_plan_limits_tenant_id_key" ON "tenant_plan_limits"("tenant_id");

ALTER TABLE "tenant_plan_limits"
    ADD CONSTRAINT "tenant_plan_limits_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same shape `PlanSchema.key` publishes, so a key written here is a key TAR-37's
-- catalogue can hold.
ALTER TABLE "tenant_plan_limits"
    ADD CONSTRAINT "tenant_plan_limits_plan_key_format" CHECK (
        "plan_key" ~ '^[a-z][a-z0-9_]{0,39}$'
    );

-- A cap of zero is not a limit, it is a lockout, and it would be reached by
-- arithmetic rather than by anyone deciding it. Unlimited is spelled NULL.
ALTER TABLE "tenant_plan_limits"
    ADD CONSTRAINT "tenant_plan_limits_caps_positive" CHECK (
        ("seat_cap" IS NULL OR "seat_cap" > 0)
        AND ("conversation_cap" IS NULL OR "conversation_cap" > 0)
    );

COMMENT ON TABLE "tenant_plan_limits" IS
    'TAR-403. The tenant''s effective plan limits, one row per tenant. The DB-backed placeholder '
    'TAR-405 enforces against and TAR-37''s plan sync later becomes the writer of. NULL = unlimited.';

COMMENT ON COLUMN "tenant_plan_limits"."seat_cap" IS
    'Billable agent seats. Maps to PlanLimitsSchema.seats. NULL = unlimited.';

COMMENT ON COLUMN "tenant_plan_limits"."conversation_cap" IS
    'Conversations opened per billing period, metered by the conversations_opened usage counter. '
    'Maps to PlanLimitsSchema.conversationsPerPeriod. NULL = unlimited.';

-- ---------------------------------------------------------------------------
-- 4. Backfills, before row-level security is switched on
-- ---------------------------------------------------------------------------
--
-- Both statements run while the new tables still have RLS off. That is not a
-- shortcut around the policy: no `app.tenant_id` GUC is set during a migration
-- and there is no single tenant these statements could set it to, so a policy's
-- `WITH CHECK` would reject every row. Each insert takes its `tenant_id` from
-- `tenants` per row, so neither can write into the wrong tenant regardless.
--
-- Ordering this before section 5 avoids the `NO FORCE` / `FORCE` toggle that
-- `20260813130000` needed for the same reason on a table that already existed.
--
-- Ids are supplied rather than defaulted: `schema.prisma` generates UUIDv7 in
-- the Prisma client and no PostgreSQL release before 18 has a native `uuidv7()`,
-- so there is no column default to fall back on. The expression lays one out per
-- RFC 9562 §5.7 — 48 bits of Unix milliseconds, the version nibble, then the
-- random tail of a `gen_random_uuid()`, whose variant bits already sit in the
-- right place. Lifted from `20260813130000`, which explains it at length.

-- Existing tenants are grandfathered **unlimited**, not onto the trial caps.
--
-- Every tenant that exists today was provisioned by an operator through
-- `POST /api/v1/admin/tenants` — none of them signed up for a trial, and none
-- was ever sold a seat cap. Backfilling `seat_cap = 3` would make TAR-405's
-- write-time enforcement reject the next invite for any tenant already past
-- three agents: a schema migration silently taking away access somebody is
-- paying for. `plan_key = 'unlimited'` says which rows those are, so a later
-- reconciliation can find them by query rather than by guessing at a date.
DO $$
DECLARE
    seeded bigint;
BEGIN
    INSERT INTO "public"."tenant_plan_limits" (
        "id", "tenant_id", "plan_key", "seat_cap", "conversation_cap", "created_at", "updated_at"
    )
    SELECT
        (
            lpad(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0')
            || '7'
            || substr(replace(gen_random_uuid()::text, '-', ''), 14)
        )::uuid,
        t."id",
        'unlimited',
        NULL,
        NULL,
        now(),
        now()
    FROM "public"."tenants" t
    WHERE NOT EXISTS (
        SELECT 1 FROM "public"."tenant_plan_limits" l WHERE l."tenant_id" = t."id"
    );

    GET DIAGNOSTICS seeded = ROW_COUNT;

    RAISE NOTICE 'tenant_plan_limits: grandfathered % existing tenant(s) as unlimited', seeded;
END
$$;

-- One genesis row per existing tenant, so no tenant's history starts empty.
--
-- `from_state` is NULL and `actor_type` is `unattributed`, which is exactly what
-- that label exists for (TAR-166): these states were reached before this table
-- existed, and inventing an actor for them would put a wrong answer in the table
-- whose whole value is being right. `to_state` is the tenant's current status,
-- so the trail agrees with the column from the first row.
DO $$
DECLARE
    seeded bigint;
BEGIN
    INSERT INTO "public"."lifecycle_audit_log" (
        "id", "tenant_id", "occurred_at", "actor_type",
        "actor_user_id", "actor_label", "from_state", "to_state", "reason", "metadata"
    )
    SELECT
        (
            lpad(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0')
            || '7'
            || substr(replace(gen_random_uuid()::text, '-', ''), 14)
        )::uuid,
        t."id",
        t."created_at",
        'unattributed',
        NULL,
        NULL,
        NULL,
        t."status",
        'Backfilled by TAR-403: state on record when the lifecycle audit trail was introduced.',
        NULL
    FROM "public"."tenants" t
    WHERE NOT EXISTS (
        SELECT 1 FROM "public"."lifecycle_audit_log" l WHERE l."tenant_id" = t."id"
    );

    GET DIAGNOSTICS seeded = ROW_COUNT;

    RAISE NOTICE 'lifecycle_audit_log: wrote a genesis row for % existing tenant(s)', seeded;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. Row-level security on both new tables (TAR-48's mechanism, unchanged)
-- ---------------------------------------------------------------------------
--
-- Same predicate, same `FORCE`, same `TO PUBLIC` role-agnosticism as every other
-- tenant-scoped table. `pnpm db:verify:rls` derives its list from the catalog
-- rather than from a file, so a table added without this block fails by name;
-- these two are here so it does not have to.

ALTER TABLE "public"."lifecycle_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."lifecycle_audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."lifecycle_audit_log"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "public"."tenant_plan_limits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_plan_limits" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."tenant_plan_limits"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 6. Append-only, enforced twice
-- ---------------------------------------------------------------------------
--
-- Privileges are the first half: `app-roles.sql` grants `SELECT, INSERT` on
-- `lifecycle_audit_log` and withholds `UPDATE, DELETE` from both application
-- roles. That is the half that constrains the application.
--
-- The trigger is the second half, and it is the one that constrains **us**. The
-- migration owner is not bound by those grants, and neither is a psql session
-- opened at 2 a.m. to "fix" a row. An audit trail that the operator can edit is
-- a record of what somebody was willing to leave behind.
--
-- It blocks UPDATE and not DELETE, and that asymmetry is deliberate:
-- PostgreSQL's referential cascade from `DELETE FROM tenants` fires a real row
-- trigger on the child, and no condition inside the trigger can distinguish it
-- from a hand-written DELETE. Blocking DELETE would therefore make the tenant
-- row undeletable — breaking the seed, every integration fixture, and any future
-- erasure request — to close a path that the grants already close for both
-- application roles. Mutation is the failure mode that corrupts the record;
-- deletion takes the whole tenant with it and is visible.
CREATE FUNCTION "public"."lifecycle_audit_log_forbid_update"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION 'lifecycle_audit_log is append-only: row % cannot be updated', OLD."id"
        USING ERRCODE = 'TN002',
              HINT = 'Record the correction as a new transition instead of editing the old one.';
END;
$$;

COMMENT ON FUNCTION "public"."lifecycle_audit_log_forbid_update"() IS
    'TAR-403. Raises TN002 on any UPDATE of lifecycle_audit_log, including by the table owner. '
    'DELETE is intentionally not blocked: it is reachable only by the ON DELETE CASCADE from '
    'tenants, which a row trigger cannot tell apart from a hand-written statement.';

CREATE TRIGGER "lifecycle_audit_log_append_only"
    BEFORE UPDATE ON "public"."lifecycle_audit_log"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."lifecycle_audit_log_forbid_update"();

-- ---------------------------------------------------------------------------
-- 7. `assert_tenant_active` learns the new states
-- ---------------------------------------------------------------------------
--
-- TAR-51's gate is called by `TenantPrisma` around every
-- `set_config('app.tenant_id', ...)`, and it admitted `active` and nothing else.
-- Adding `trialing` and `past_due` to the enum without touching it would ship a
-- lockout: a tenant that signs up and lands in `trialing` — which is every
-- tenant TAR-405 creates — could not run a single query.
--
-- What changes, and what deliberately does not:
--
--   trialing   Admitted. A trial is a working product; refusing it makes the
--              signup flow TAR-405 builds unusable on its first request.
--   past_due   Admitted. Dunning is a billing banner, not an outage —
--              `TENANT_STATUS_EFFECTS` in the published contract has it fully
--              operational, and the grace period exists precisely so a failed
--              payment does not take access away on the same day.
--   created    Still refused. Provisioning has not finished; the tenant's
--              settings, domain and policies may not exist yet.
--   suspended  Still refused. Unchanged from TAR-51, and it matches TAR-404's
--   cancelled  acceptance criterion that a suspended tenant's agents cannot log
--              in.
--   deleted    Refused, and it is new. A purged tenant is a tombstone.
--
-- **One published inconsistency, named rather than silently resolved.**
-- `TENANT_STATUS_EFFECTS` marks `suspended` and `cancelled` as `apiAccess:
-- true` with only outbound messaging withdrawn, while this gate — shipped by
-- TAR-51 and unchanged here — refuses them outright at the connection. Both
-- cannot be right. Loosening a security gate is not a schema migration's call,
-- so this file keeps the stricter behaviour and TAR-397 / TAR-404 decide which
-- one stands. Flagged on TAR-403.
--
-- `CREATE OR REPLACE`, so this is safe to apply to a database at either version
-- and safe to re-run. `EXECUTE` is managed by `app-roles.sql`; replacing a
-- function does not disturb its grants.
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
        -- A tenant row that was erased outright, or an id from a session issued
        -- against another database. Same answer as a deactivated one: the
        -- caller learns nothing about which it was.
        RAISE EXCEPTION 'TENANT_NOT_ACTIVE: tenant % does not exist', tenant_id
            USING ERRCODE = 'TN001';
    END IF;

    -- Allow-list, not a deny-list. A label added to `tenant_status` by a later
    -- migration is refused until somebody decides it should not be, which is the
    -- direction this failure should point.
    IF current_status <> ALL (ARRAY['active', 'trialing', 'past_due']::"public"."tenant_status"[]) THEN
        RAISE EXCEPTION 'TENANT_NOT_ACTIVE: tenant % is %', tenant_id, current_status
            USING ERRCODE = 'TN001';
    END IF;

    RETURN tenant_id;
END;
$$;

COMMENT ON FUNCTION "public"."assert_tenant_active"(text) IS
    'TAR-51, extended by TAR-403. Returns the tenant id when that tenant may serve requests — '
    'active, trialing or past_due — and raises TN001 otherwise. Called by TenantPrisma around '
    'every set_config(''app.tenant_id'', ...), so a tenant that is created, suspended, cancelled '
    'or deleted never sets the GUC that TAR-48''s RLS policies read. Reads tenants as the calling '
    'role, so whatsappcrm_app''s SELECT on that table is load-bearing.';
