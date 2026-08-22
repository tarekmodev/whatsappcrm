-- Make a plan key that the published contract refuses impossible to store
-- (TAR-657).
--
-- `PlanSchema.key` in `packages/contracts/src/billing.ts` is `PLAN_KEY_PATTERN`
-- — `^[a-z][a-z0-9_]*$`, at most `PLAN_KEY_MAX_LENGTH` characters — and until
-- this migration nothing enforced it. `plans.key` is plain `text` with a unique
-- index; `plans_entitlements_shape` guards the `entitlements` JSON and says
-- nothing about the key.
--
-- The gap is visible from the sibling table: `tenant_entitlements.plan_key` has
-- carried this exact grammar since TAR-403 shipped it in
-- `20260815130000_tenant_lifecycle_retention_audit_and_limits` (as
-- `tenant_plan_limits_plan_key_format`, renamed with the table two migrations
-- later). The *copy* of the key was constrained and the *source* of it was not,
-- so a seed, a fixture, an admin tool or a hand-written migration could write
-- any string at all.
--
-- `GET /billing/plans` returns every `is_active` row unfiltered, and the console
-- validates that response against the same contract. So one non-conforming row
-- was not a bad plan card: it failed `PlanListResponseSchema.parse()` for the
-- whole response and put the billing page's error boundary in front of every
-- tenant on the platform, with nothing on screen to recover from.
--
-- Two independent repairs ship for that outage, because either alone still
-- leaves a hole. The console now validates the plans one at a time and drops
-- only the row that fails; this constraint is the half that stops the row
-- existing.
--
-- ---------------------------------------------------------------------------
-- 1. Repair the rows that are already there
-- ---------------------------------------------------------------------------
--
-- A CHECK is added against existing data, so a non-conforming row has to be
-- dealt with before section 2 or the migration aborts — and on the database that
-- produced TAR-657 there is exactly one such row.
--
-- Renaming rather than deleting, deliberately. `subscriptions.plan_id` is
-- `ON DELETE NO ACTION`, so a delete would fail against a subscribed tenant, and
-- a catalogue row is not this migration's to destroy. The rename is
-- deterministic: lowercase, every character outside `[a-z0-9_]` becomes `_`, a
-- key not starting with a letter is prefixed `plan_`, the result truncated to 40
-- characters and given a suffix from the row id if that collides with a key
-- already taken. `tar405-cap-plan` becomes `tar405_cap_plan`, which is also the
-- key the fixture that wrote it now uses — so the next `pnpm test:db` removes it
-- as its own.
--
-- `tenant_entitlements.plan_key` is a text mirror of this key rather than a
-- foreign key, so it is carried along in the same loop. In practice it matches
-- nothing: `tenant_entitlements_plan_key_format` has been refusing these keys
-- all along, which is why the outage was a rendering failure rather than a
-- broken tenant. But a repair that leaves a dangling reference behind on the one
-- database where it does match is not a repair.
--
-- Idempotent by construction: on a second run the loop finds nothing.

DO $$
DECLARE
    offender  RECORD;
    repaired  TEXT;
BEGIN
    FOR offender IN
        SELECT "id", "key"
        FROM "public"."plans"
        WHERE "key" !~ '^[a-z][a-z0-9_]{0,39}$'
        ORDER BY "key"
    LOOP
        repaired := regexp_replace(lower(offender."key"), '[^a-z0-9_]', '_', 'g');

        IF repaired !~ '^[a-z]' THEN
            repaired := 'plan_' || repaired;
        END IF;

        repaired := left(repaired, 40);

        -- `key` is unique. Two offenders can normalise onto the same string, and
        -- one can normalise onto a key already in the catalogue; the row id is
        -- unique by definition, so eight characters of it settle both cases.
        IF EXISTS (
            SELECT 1 FROM "public"."plans"
            WHERE "key" = repaired AND "id" <> offender."id"
        ) THEN
            repaired := left(repaired, 31) || '_' || left(replace(offender."id"::text, '-', ''), 8);
        END IF;

        UPDATE "public"."plans" SET "key" = repaired WHERE "id" = offender."id";

        UPDATE "public"."tenant_entitlements"
        SET "plan_key" = repaired
        WHERE "plan_key" = offender."key";

        RAISE NOTICE 'TAR-657: plan key % is outside the published contract and was renamed to %',
            offender."key", repaired;
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. The constraint
-- ---------------------------------------------------------------------------
--
-- `^[a-z][a-z0-9_]{0,39}$` is `PLAN_KEY_PATTERN` with `PLAN_KEY_MAX_LENGTH`
-- folded into the quantifier, and it is character for character
-- `tenant_entitlements_plan_key_format`. Written that way rather than as a regex
-- beside a `length()` test so the two tables holding the same value visibly hold
-- the same rule; `canned_responses_shortcut_format` (TAR-475) is the same
-- construction.
--
-- `apps/api/src/prisma/plan-catalogue-schema.int-spec.ts` asserts this body and
-- checks every key it refuses against the contract's own `PLAN_KEY_PATTERN`, so
-- the database and the published schema cannot drift apart unnoticed. Prisma's
-- schema language cannot express a CHECK and its describer does not report one,
-- so `migrate dev` proposes neither to create nor to drop this: without that
-- spec, nothing in the toolchain would notice it disappearing.
--
-- `DROP ... IF EXISTS` first, so re-running the file is a no-op.
--
-- `plans` is a catalogue of a handful of rows, so the ACCESS EXCLUSIVE lock this
-- takes is measured in milliseconds. `lock_timeout` is set anyway, to the same
-- three seconds the rest of the migrations use: a reader holding this table
-- should abort the migration cleanly rather than queue every query behind it.

SET LOCAL lock_timeout = '3s';

ALTER TABLE "public"."plans"
    DROP CONSTRAINT IF EXISTS "plans_key_format";

ALTER TABLE "public"."plans"
    ADD CONSTRAINT "plans_key_format"
    CHECK ("key" ~ '^[a-z][a-z0-9_]{0,39}$');

COMMENT ON COLUMN "public"."plans"."key" IS
    'Stable business key. All plan logic branches on this, never on a provider '
    'id. plans_key_format mirrors PLAN_KEY_PATTERN in the published contract, '
    'and matches tenant_entitlements_plan_key_format on the copy of this value '
    '(TAR-657).';
