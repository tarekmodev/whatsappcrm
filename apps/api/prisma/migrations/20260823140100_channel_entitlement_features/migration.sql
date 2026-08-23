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
-- The other two are data, and are sections 1 and 2 of this file:
--
--   * every existing `tenant_entitlements.entitlements` row
--   * the column default that every future self-signup row takes, which is also
--     what the self-signup provisioning path relies on rather than restating
--
-- ---------------------------------------------------------------------------
-- The fifth site, which the ADR's list of four does not name
-- ---------------------------------------------------------------------------
--
-- **`plans.entitlements`, in section 3.** Without it section 1 does not survive
-- the next billing event.
--
-- `SubscriptionSyncService.copyEntitlements` **replaces**
-- `tenant_entitlements.entitlements` wholesale from `plans.entitlements`, inside
-- the transaction that applies a subscription — that is decision 4 of the
-- billing contract, and it is what makes a purchased plan's limits take effect
-- immediately. So a `plans` row seeded before this release overwrites section 1's
-- backfill with an array that has no `channel_whatsapp`, and the tenant loses a
-- capability nobody removed. Once TAR-821's fail-closed gate lands, that is
-- WhatsApp connect refused for a paying tenant on the next webhook Polar sends —
-- precisely the day-one breakage decision 4 counts write sites to prevent.
--
-- The `demo-dataset.ts` plan rows carry the same three features and move in this
-- commit, but seed data cannot stand in for this: `db:seed` is in neither
-- `preDeployCommand` in `render.yaml`, so an environment carrying `plans` rows
-- from before this release is never re-seeded.
--
-- `20260822130000_billing_polar_provider_ids` is the precedent and argues the
-- same case in its own section 3 — it reshapes existing `plans.entitlements`
-- rows in a migration rather than through the seed, on the grounds that decision
-- 4 copies them into `tenant_entitlements`, and notes that the contract's delta
-- list did not name them either.
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
--                per tenant; the plan catalogue is a handful of rows.
--   Locks        ROW EXCLUSIVE on `tenant_entitlements` and `plans` for the two
--                UPDATEs, and ACCESS EXCLUSIVE for the `SET DEFAULT`, which is
--                catalog-only and does not rewrite the table.
--   Blocking     Nil in practice. Nothing writes either table on a request path;
--                their writers are provisioning, the subscription sync and the
--                lifecycle sweep.
--   Data loss    None. Both updates append to a JSONB array and rewrite no other
--                key — `jsonb_set` on `features` alone, not a replacement of the
--                document.
--   Rollback     `down.sql` beside this file. It removes the same value from the
--                same rows in both tables and restores the previous default.
--
-- Idempotent: every statement is conditional, so a fresh database, one at the
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

    -- The post-condition, not the row count. ADR 0013 rule 0 asks every backfill
    -- to close with an assertion against its source; this table is its own
    -- source, so the assertion is that **no row is left without the feature**.
    --
    -- Deliberately stricter than "the UPDATE matched something". Zero rows
    -- updated is a legitimate outcome — a fresh database, or a second
    -- application — and would pass a row-count check while an untoggled table
    -- also passes it. Counting the rows that still lack the value distinguishes
    -- the two.
    --
    -- A row whose `features` is not an array is out of scope for the UPDATE and
    -- for this check: `tenant_entitlements_shape` already refuses one, and
    -- silently "fixing" a malformed document here would hide a constraint
    -- violation behind a backfill.
    IF EXISTS (
        SELECT 1 FROM "public"."tenant_entitlements"
         WHERE jsonb_typeof("entitlements"::jsonb -> 'features') = 'array'
           AND NOT ("entitlements"::jsonb -> 'features' @> '"channel_whatsapp"'::jsonb)
    ) THEN
        RAISE EXCEPTION
            '% tenant_entitlements row(s) still lack channel_whatsapp after the backfill; '
            'a fail-closed channel gate would refuse WhatsApp connect for each of them',
            (
                SELECT count(*) FROM "public"."tenant_entitlements"
                 WHERE jsonb_typeof("entitlements"::jsonb -> 'features') = 'array'
                   AND NOT ("entitlements"::jsonb -> 'features' @> '"channel_whatsapp"'::jsonb)
            );
    END IF;

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

-- ---------------------------------------------------------------------------
-- 3. The plan catalogue
-- ---------------------------------------------------------------------------
--
-- The fifth write site, and the one that makes section 1 durable rather than
-- true-until-the-next-webhook. The header has the reasoning; the statement is
-- section 1's, with two differences.
--
-- **No FORCE toggle.** `plans` is one of the six tables with no
-- `tenant_isolation` policy — a platform-wide catalogue, the same rows for every
-- tenant, and `20260810140000_tenant_isolation_rls` names it as a deliberate
-- exception. There is nothing to toggle and nothing hiding rows from this
-- UPDATE.
--
-- **Every plan, including inactive ones.** A tenant sitting on a retired plan is
-- exactly the tenant whose entitlements nobody is watching, and
-- `copyEntitlements` reads the row the subscription names rather than the row
-- the catalogue is currently selling. `is_active` is about what may be bought,
-- not about what is in force.
--
-- `plans_entitlements_shape` still applies to the result: it asserts `features`
-- is an array and the five limit keys are present, both of which survive an
-- append to `features` alone.

DO $$
DECLARE
    updated bigint;
BEGIN
    UPDATE "public"."plans"
       SET "entitlements" = jsonb_set(
               "entitlements"::jsonb,
               '{features}',
               ("entitlements"::jsonb -> 'features') || '"channel_whatsapp"'::jsonb
           )
     WHERE jsonb_typeof("entitlements"::jsonb -> 'features') = 'array'
       AND NOT ("entitlements"::jsonb -> 'features' @> '"channel_whatsapp"'::jsonb);

    GET DIAGNOSTICS updated = ROW_COUNT;

    -- The same post-condition, and it matters more here than in section 1: a
    -- plan row left without the feature does not stay a local gap.
    -- `copyEntitlements` writes it over every tenant on that plan at the next
    -- subscription event, so one missed catalogue row silently un-does section 1
    -- for a whole tier.
    IF EXISTS (
        SELECT 1 FROM "public"."plans"
         WHERE jsonb_typeof("entitlements"::jsonb -> 'features') = 'array'
           AND NOT ("entitlements"::jsonb -> 'features' @> '"channel_whatsapp"'::jsonb)
    ) THEN
        RAISE EXCEPTION
            'plan(s) % still lack channel_whatsapp after the backfill; copyEntitlements '
            'would write that array over every tenant on them at the next subscription event',
            (
                SELECT string_agg("key", ', ' ORDER BY "key") FROM "public"."plans"
                 WHERE jsonb_typeof("entitlements"::jsonb -> 'features') = 'array'
                   AND NOT ("entitlements"::jsonb -> 'features' @> '"channel_whatsapp"'::jsonb)
            );
    END IF;

    RAISE NOTICE 'channel_whatsapp added to % plan row(s)', updated;
END
$$;
