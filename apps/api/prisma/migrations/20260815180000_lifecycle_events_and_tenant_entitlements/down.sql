-- Reverses 20260815180000_lifecycle_events_and_tenant_entitlements.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE RUNNING IT: what it destroys, and what it can refuse to do
-- ---------------------------------------------------------------------------
--
-- Two losses, both narrow but neither recoverable:
--
--   * **Three of the five entitlement limits.** `tenant_plan_limits` holds
--     `seat_cap` and `conversation_cap` and has nowhere to put
--     `whatsappNumbers`, `teams` or `knowledgeDocuments`. A tenant sold a real
--     plan by TAR-37 loses those three ceilings, and the `features` array with
--     them. The two caps round-trip exactly.
--   * **`plan_name`.** Derived from `plan_key` on the way forward, so a name
--     edited by hand afterwards is gone.
--
-- And one way this file can **fail rather than run**, which is deliberate:
-- restoring `lifecycle_audit_log`'s foreign keys revalidates them against the
-- rows in the table. If a purge has run since the forward migration — the whole
-- reason ruling 2 exists — the trail holds rows naming `users` that no longer
-- exist, and the `ADD CONSTRAINT` raises 23503 and aborts the transaction. That
-- is the correct outcome: the alternative is dropping audit rows to make a
-- rollback fit, and this file will not do that silently.
--
-- If you need the rollback anyway on such a database, the forward fix is a new
-- migration rather than this one. Take a verified backup either way.
--
-- ---------------------------------------------------------------------------
-- What it deliberately does not do
-- ---------------------------------------------------------------------------
--
-- It does not restore the app-role grant on `lifecycle_audit_log`, or the
-- `system_unrestricted` policy on either table. Both are `app-roles.sql`'s, and
-- **`pnpm db:roles` has to be re-run after this file** — until it is, the
-- restored `tenant_isolation` policy sits on a table the app role can no longer
-- reach, which fails safe rather than open.
--
-- ---------------------------------------------------------------------------
-- Order
-- ---------------------------------------------------------------------------
--
-- Renames first in both sections, so every later statement names the object as
-- the previous migration knew it. The trigger function is recreated against the
-- restored composite type rather than renamed, for the same reason the forward
-- file recreates it: the body resolves `probe`'s type when it runs.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. `lifecycle_events` → `lifecycle_audit_log`
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."lifecycle_events" RENAME TO "lifecycle_audit_log";

ALTER INDEX "public"."lifecycle_events_pkey"
    RENAME TO "lifecycle_audit_log_pkey";
ALTER INDEX "public"."lifecycle_events_tenant_id_occurred_at_id_idx"
    RENAME TO "lifecycle_audit_log_tenant_id_occurred_at_id_idx";
ALTER INDEX "public"."lifecycle_events_notified_at_pending_idx"
    RENAME TO "lifecycle_audit_log_notified_at_pending_idx";

ALTER TABLE "public"."lifecycle_audit_log"
    RENAME CONSTRAINT "lifecycle_events_actor_attribution"
    TO "lifecycle_audit_log_actor_attribution";

ALTER TABLE "public"."lifecycle_audit_log"
    RENAME CONSTRAINT "lifecycle_events_transition_changes_state"
    TO "lifecycle_audit_log_transition_changes_state";

DROP TRIGGER "lifecycle_events_append_only" ON "public"."lifecycle_audit_log";
DROP FUNCTION "public"."lifecycle_events_forbid_update"();

CREATE FUNCTION "public"."lifecycle_audit_log_forbid_update"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    probe "public"."lifecycle_audit_log";
BEGIN
    IF OLD."notified_at" IS NULL AND NEW."notified_at" IS NOT NULL THEN
        probe := NEW;
        probe."notified_at" := OLD."notified_at";

        IF probe IS NOT DISTINCT FROM OLD THEN
            RETURN NEW;
        END IF;
    END IF;

    RAISE EXCEPTION 'lifecycle_audit_log is append-only: row % cannot be updated', OLD."id"
        USING ERRCODE = 'TN002',
              HINT = 'Only notified_at may be UPDATEd, once, from NULL. Record a correction as a '
                     'new transition instead of editing the old one.';
END;
$$;

CREATE TRIGGER "lifecycle_audit_log_append_only"
    BEFORE UPDATE ON "public"."lifecycle_audit_log"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."lifecycle_audit_log_forbid_update"();

-- Row-level security back on, with the policy TAR-403 wrote.
ALTER TABLE "public"."lifecycle_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."lifecycle_audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."lifecycle_audit_log"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The two foreign keys. This is the pair that can refuse to be restored — see
-- the header. Nothing here suppresses that: a `NOT VALID` constraint would let
-- the rollback succeed while leaving the schema claiming an integrity it does
-- not have, which is worse than an honest abort.
ALTER TABLE "public"."lifecycle_audit_log"
    ADD CONSTRAINT "lifecycle_audit_log_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."lifecycle_audit_log"
    ADD CONSTRAINT "lifecycle_audit_log_tenant_id_actor_user_id_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "users"("tenant_id", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMENT ON TABLE "public"."lifecycle_audit_log" IS
    'TAR-403. Append-only, one row per tenant lifecycle transition. Survives hard-delete: the '
    'tenants row remains as a tombstone in status = ''deleted'' and these rows remain with it.';

-- ---------------------------------------------------------------------------
-- 2. `tenant_entitlements` → `tenant_plan_limits`
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."tenant_entitlements" RENAME TO "tenant_plan_limits";

ALTER INDEX "public"."tenant_entitlements_pkey"
    RENAME TO "tenant_plan_limits_pkey";
ALTER INDEX "public"."tenant_entitlements_tenant_id_key"
    RENAME TO "tenant_plan_limits_tenant_id_key";

ALTER TABLE "public"."tenant_plan_limits"
    RENAME CONSTRAINT "tenant_entitlements_tenant_id_fkey"
    TO "tenant_plan_limits_tenant_id_fkey";

ALTER TABLE "public"."tenant_plan_limits"
    RENAME CONSTRAINT "tenant_entitlements_plan_key_format"
    TO "tenant_plan_limits_plan_key_format";

ALTER TABLE "public"."tenant_plan_limits"
    DROP CONSTRAINT "tenant_entitlements_shape";

-- The two caps come back out of the jsonb, which is the half that round-trips.
-- `NULL` in the JSON and a missing key both read as SQL NULL through `->>`, and
-- both mean unlimited, so the cast needs no special case.
ALTER TABLE "public"."tenant_plan_limits"
    ADD COLUMN "seat_cap" INTEGER DEFAULT 3,
    ADD COLUMN "conversation_cap" INTEGER DEFAULT 1000;

UPDATE "public"."tenant_plan_limits"
   SET "seat_cap" = ("entitlements" -> 'limits' ->> 'seats')::int,
       "conversation_cap" = ("entitlements" -> 'limits' ->> 'conversationsPerPeriod')::int;

ALTER TABLE "public"."tenant_plan_limits"
    ADD CONSTRAINT "tenant_plan_limits_caps_positive" CHECK (
        ("seat_cap" IS NULL OR "seat_cap" > 0)
        AND ("conversation_cap" IS NULL OR "conversation_cap" > 0)
    );

ALTER TABLE "public"."tenant_plan_limits"
    DROP COLUMN "entitlements",
    DROP COLUMN "plan_name";

COMMENT ON TABLE "public"."tenant_plan_limits" IS
    'TAR-403. The tenant''s effective plan limits, one row per tenant. The DB-backed placeholder '
    'TAR-405 enforces against and TAR-37''s plan sync later becomes the writer of. NULL = unlimited.';

-- ---------------------------------------------------------------------------
-- 3. `assert_tenant_serviceable` goes back to the pre-amendment allow-list
-- ---------------------------------------------------------------------------
--
-- Restored to what `20260815170000` created, `cancelled` refused. Inert either
-- way while the function has no callers; if TAR-404's engine has already
-- repointed the extension, running this file closes the recovery allowlist and a
-- cancelled tenant's admin can no longer log in to undo the cancellation.
CREATE OR REPLACE FUNCTION "public"."assert_tenant_serviceable"(tenant_id text)
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $$
DECLARE
    current_status "public"."tenant_status";
BEGIN
    IF tenant_id IS NULL OR tenant_id = '' THEN
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: no tenant id was supplied'
            USING ERRCODE = 'TN001';
    END IF;

    IF tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: tenant id % is not a uuid', tenant_id
            USING ERRCODE = 'TN001';
    END IF;

    SELECT t."status" INTO current_status
    FROM "public"."tenants" t
    WHERE t."id" = tenant_id::uuid;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: tenant % does not exist', tenant_id
            USING ERRCODE = 'TN001';
    END IF;

    IF current_status <> ALL (
        ARRAY['trialing', 'active', 'past_due', 'suspended']::"public"."tenant_status"[]
    ) THEN
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: tenant % is %', tenant_id, current_status
            USING ERRCODE = 'TN001';
    END IF;

    RETURN tenant_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The sweeper indexes go back to `IS NOT NULL` alone
-- ---------------------------------------------------------------------------
--
-- Wider than what replaces them, so a sweep written against either predicate
-- still finds its rows after this runs — this is the one part of the file that
-- cannot break a caller.
DROP INDEX "public"."tenants_grace_due";
DROP INDEX "public"."tenants_purge_due";

CREATE INDEX "tenants_grace_period_ends_at_idx" ON "public"."tenants"("grace_period_ends_at")
    WHERE "grace_period_ends_at" IS NOT NULL;

CREATE INDEX "tenants_purge_at_idx" ON "public"."tenants"("purge_at")
    WHERE "purge_at" IS NOT NULL;
