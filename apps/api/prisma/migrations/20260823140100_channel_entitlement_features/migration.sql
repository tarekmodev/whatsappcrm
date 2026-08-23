-- Per-channel entitlements (TAR-819, ADR 0013 decision 4, TAR-808 AC3).
--
-- Three new `PLAN_FEATURES` values — `channel_whatsapp`, `channel_instagram`,
-- `channel_messenger` — become the gate on connecting a channel of each kind.
-- This migration is the database half: it puts `channel_whatsapp` into every
-- entitlements row that already exists and into the column default every future
-- row takes, so that the fail-closed reader TAR-821 adds refuses nothing that
-- works today.
--
-- ---------------------------------------------------------------------------
-- Why a backfill is the load-bearing part
-- ---------------------------------------------------------------------------
--
-- `PlanFeaturesService.includes()` fails **open** by design and documents why:
-- an unstated feature is granted, because failing closed would refuse every
-- tenant on the platform today. That is right for `ai_chatbot` and exactly wrong
-- for AC3, which requires a refusal with a reason. So TAR-821 adds a second,
-- fail-closed reader — and a fail-closed reader is only safe once every write
-- site names the feature.
--
-- ADR 0013 counts four such sites. Two of them are code that spreads
-- `PLAN_FEATURES` and therefore moved on their own the moment the constant did:
--
--   * `UNCAPPED_ENTITLEMENTS` in `apps/api/src/entitlements/plan-limits.service.ts`
--   * `operatorEntitlements()` in `apps/api/src/tenancy/tenant-provisioning.service.ts`
--
-- The other two are data, and are this file:
--
--   * every existing `tenant_entitlements.entitlements` row
--   * the column default that every future self-signup row takes, which is also
--     what the self-signup provisioning path relies on rather than restating
--
-- The `demo-dataset.ts` plan rows are the fifth, and they are seed data rather
-- than a migration — they move in the same commit.
--
-- ---------------------------------------------------------------------------
-- Why only `channel_whatsapp`
-- ---------------------------------------------------------------------------
--
-- Granting a feature that names something the tenant already does is a
-- description, not a decision: every tenant on the platform can connect a
-- WhatsApp number today, and withholding `channel_whatsapp` from them would be
-- the change in behaviour, not adding it.
--
-- `channel_instagram` and `channel_messenger` are the opposite — nobody has been
-- sold either — so nothing here grants them, and a tenant that should have one
-- gets it the way any other entitlement override is made: by writing a different
-- `features` array into that tenant's row. `tenant_entitlements` **is** the
-- per-tenant materialisation of a plan (TAR-403, diverging from ADR 0009
-- decision 6 for exactly this reason). There is no third table, and TAR-821
-- should not invent one.
--
-- Rows already carrying `channel_whatsapp` are left alone, and so is the order
-- of every other feature in the array: the append is conditional, so applying
-- this twice is a no-op rather than a row with two copies.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. One row per tenant, and the table holds one row
--                per tenant.
--   Locks        ROW EXCLUSIVE on `tenant_entitlements` for the UPDATE, and
--                ACCESS EXCLUSIVE for the `SET DEFAULT`, which is catalog-only
--                and does not rewrite the table.
--   Blocking     Nil in practice. Nothing writes this table on a request path;
--                its writers are provisioning and the lifecycle sweep.
--   Data loss    None. The update appends to a JSONB array and rewrites no other
--                key — `jsonb_set` on `features` alone, not a replacement of the
--                document.
--   Rollback     `down.sql` beside this file. It removes the same value from the
--                same rows and restores the previous default.
--
-- Idempotent: both statements are conditional, so a fresh database, one at the
-- previous version, and a second application all reach the same state.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Existing rows
-- ---------------------------------------------------------------------------
--
-- `FORCE ROW LEVEL SECURITY` is toggled off for the same reason every other
-- backfill in this repository does it: `tenant_entitlements` carries the
-- `tenant_isolation` policy, no migration sets `app.tenant_id`, and there is no
-- single tenant this statement could set it to — so with FORCE on the UPDATE
-- would match zero rows and report success. The statement writes no `tenant_id`
-- and touches one key of one column, so it cannot move a row between tenants.
--
-- Safe inline: DDL is transactional, this migration holds its locks for its whole
-- duration, and an abort rolls the toggle back with everything else.
--
-- `tenant_entitlements_shape` — the CHECK that asserts the five limit keys and
-- that `features` is an array — still applies to the result. It cannot check the
-- feature *values*, so `PlanEntitlementsSchema` at every write site remains the
-- actual contract; this statement is written to satisfy both.

DO $$
DECLARE
    updated bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."tenant_entitlements" NO FORCE ROW LEVEL SECURITY';

    UPDATE "public"."tenant_entitlements"
       SET "entitlements" = jsonb_set(
               "entitlements"::jsonb,
               '{features}',
               ("entitlements"::jsonb -> 'features') || '"channel_whatsapp"'::jsonb
           )
     WHERE jsonb_typeof("entitlements"::jsonb -> 'features') = 'array'
       AND NOT ("entitlements"::jsonb -> 'features' @> '"channel_whatsapp"'::jsonb);

    GET DIAGNOSTICS updated = ROW_COUNT;

    EXECUTE 'ALTER TABLE "public"."tenant_entitlements" FORCE ROW LEVEL SECURITY';

    RAISE NOTICE 'channel_whatsapp added to % tenant_entitlements row(s)', updated;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. The column default
-- ---------------------------------------------------------------------------
--
-- 0009's published trial shape, plus `channel_whatsapp`. It stays a column
-- default rather than moving into provisioning, for the reason
-- `startingState()` gives: the self-signup path deliberately restates no limit,
-- so the trial's real figures live in exactly one place and TAR-397 edits that
-- one place. Adding the feature to the default is what keeps that true.

ALTER TABLE "public"."tenant_entitlements"
    ALTER COLUMN "entitlements"
    SET DEFAULT '{"features":["assignment_rules","sla_policies","channel_whatsapp"],"limits":{"seats":3,"conversationsPerPeriod":1000,"whatsappNumbers":1,"teams":2,"knowledgeDocuments":10}}';
