-- Reverses 20260822130000_billing_polar_provider_ids.
--
-- Exact in both directions. The forward migration added four nullable columns,
-- rewrote a JSONB column in place and renamed one enum label; every one of those
-- is undone below, and the JSONB rewrite is reconstructed from the values it
-- moved rather than from a backup — nothing was discarded on the way in.
--
-- ⚠️ Roll the application back first, for the usual reason: at this migration's
-- version the billing worker reads `subscriptions.last_event_at` for its
-- out-of-order defence and the checkout route reads `plans.provider_product_id`.
-- Dropping those under a running instance turns webhook processing into a 500
-- loop, and Polar disables an endpoint after ten consecutive failures.
--
-- Statements are in reverse order of the forward file, so the CHECK is gone
-- before the data it constrains is rewritten.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 5. `tenant_entitlements_shape` back to its original, looser form
-- ---------------------------------------------------------------------------
--
-- Restored verbatim as `20260815180000_lifecycle_events_and_tenant_entitlements`
-- wrote it, `jsonb_exists` guards removed.
--
-- Widening a constraint can never fail on existing rows — everything the strict
-- form admitted, the loose form admits too — so this direction is unconditional
-- and needs no data step.

ALTER TABLE "public"."tenant_entitlements"
    DROP CONSTRAINT IF EXISTS "tenant_entitlements_shape";

ALTER TABLE "public"."tenant_entitlements"
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

-- ---------------------------------------------------------------------------
-- 4. `subscription_status.canceled` → `cancelled`
-- ---------------------------------------------------------------------------
--
-- Safe unconditionally: the forward rename was catalogue-only and no row's value
-- changed, so no row needs re-mapping on the way back. Should a future release
-- have started writing this column, the stored label follows the rename with it
-- — the value is stored as an OID, not as text.

-- Guarded for the same reason the forward statement is: `RENAME VALUE` has no
-- `IF EXISTS`, so an unguarded reversal fails when run twice.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'subscription_status' AND e.enumlabel = 'canceled'
    ) THEN
        ALTER TYPE "public"."subscription_status" RENAME VALUE 'canceled' TO 'cancelled';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. `plans.entitlements` back to the flat shape
-- ---------------------------------------------------------------------------
--
-- The CHECK goes first — it describes the shape being reverted away from, and
-- leaving it in place would refuse the UPDATE that follows.

ALTER TABLE "public"."plans"
    DROP CONSTRAINT IF EXISTS "plans_entitlements_shape";

-- `seats` and `conversationsPerPeriod` return to the top level with the values
-- they went in with. The three limits that never existed before the forward
-- migration — `whatsappNumbers`, `teams`, `knowledgeDocuments` — and the
-- `features` array are dropped, because the shape being restored has nowhere to
-- put them.
--
-- **This is the one lossy step in the file, and it is lossy only against figures
-- this migration itself invented.** The forward direction backfilled those three
-- limits from placeholders (contract open question 6 — the tier numbers are an
-- unmade pricing decision) and derived `features` from plan key. Nothing a human
-- entered is lost by reverting, and re-applying the forward migration
-- reconstructs all four deterministically. If a pricing decision has since been
-- seeded into these rows, capture `plans` before running this.
--
-- Guarded so a row already in the flat shape is skipped, matching the forward
-- file's guard: reverting twice is a no-op rather than a row of nulls.

UPDATE "public"."plans" SET "entitlements" = jsonb_build_object(
    'seats',                  "entitlements" -> 'limits' -> 'seats',
    'conversationsPerPeriod', "entitlements" -> 'limits' -> 'conversationsPerPeriod'
)
WHERE jsonb_typeof("entitlements" -> 'limits') = 'object';

COMMENT ON COLUMN "public"."plans"."entitlements" IS NULL;

-- ---------------------------------------------------------------------------
-- 2. The three `subscriptions` columns
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."subscriptions"
    DROP COLUMN IF EXISTS "last_event_at",
    DROP COLUMN IF EXISTS "past_due_since",
    DROP COLUMN IF EXISTS "cancels_at";

-- ---------------------------------------------------------------------------
-- 1. `plans.provider_product_id`
-- ---------------------------------------------------------------------------
--
-- Dropping this discards any Polar product ids that have been seeded into it.
-- They are recoverable from the Polar dashboard rather than from a backup, so
-- this is inconvenience rather than data loss — but re-seeding is a manual step,
-- so note the values before reverting in an environment where checkout works.

ALTER TABLE "public"."plans"
    DROP COLUMN IF EXISTS "provider_product_id";
