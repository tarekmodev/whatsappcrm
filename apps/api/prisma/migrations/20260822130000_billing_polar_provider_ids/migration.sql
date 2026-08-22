-- Billing schema for the Polar.sh integration (TAR-617, phase 1 of TAR-37).
--
-- The billing contract published on TAR-616 lists four deltas against what is
-- already migrated. Three of them are here. The fourth — "nothing for the
-- webhook log" — is the absence of a table, and this migration honours it by
-- creating none: `webhook_events` already carries
-- `@@unique(provider, provider_event_id)`, which is the entire replay defence,
-- and Polar rows land in it with `provider = 'polar'`.
--
-- Three further changes are **not** in the contract's delta list and are called
-- out as such in sections 3, 4 and 5 below. Each is a case where the contract's
-- prose and the migrated schema disagree, and each disagreement would surface as
-- a runtime failure in TAR-618 rather than as a review comment here.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Four added columns, one enum label renamed, and
--                a JSONB rewrite of a catalogue table that holds one row per
--                plan tier — three rows in every environment that exists today.
--   Locks        ACCESS EXCLUSIVE on `plans` and `subscriptions`, held for the
--                statements themselves. `lock_timeout` is set below so this
--                queues behind nothing: it fails fast rather than blocking
--                traffic behind a lock it could not get.
--   Blocking     Nil in practice. Every added column is nullable with no
--                default, so PostgreSQL records a catalogue entry and rewrites
--                no rows. The one UPDATE touches a table of single digits.
--   Data loss    None. Section 3 rewrites `plans.entitlements` in place and the
--                reversal in `down.sql` reconstructs the previous shape exactly
--                from the values it moved — nothing is discarded on the way in.
--   Rollback     `down.sql` beside this file. Reversible in full.
--
-- Nothing in the application writes `subscriptions` or reads
-- `plans.entitlements` in its new shape yet — `BillingProvider` has no
-- implementation on `main` — so this lands ahead of its consumers by design.
-- The one exception is called out in section 3.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. `plans.provider_product_id` (contract delta 1)
-- ---------------------------------------------------------------------------
--
-- Polar's `POST /v1/checkouts/` takes `products: uuid[]`. `provider_price_id`
-- alone cannot open a checkout, so the adapter needs the product id and this is
-- where it lives. The price column is kept rather than replaced: a second
-- provider — the GCC rail TAR-37's architect note anticipates — may well key on
-- a price, and dropping a column to re-add it later is the one shape of change
-- this schema cannot do online.
--
-- Nullable on purpose and seeded null. Polar credentials are outstanding
-- (contract open question 4), and a plan with no product id is a plan the
-- checkout route refuses with `upstream_unavailable` — which is the correct
-- answer, and a far better one than sending Polar a null and reading its error.

ALTER TABLE "public"."plans"
    ADD COLUMN IF NOT EXISTS "provider_product_id" TEXT;

COMMENT ON COLUMN "public"."plans"."provider_product_id" IS
    'The payment provider''s product id. Polar checkout takes products, not prices, '
    'so this is what the adapter sends. Opaque outside billing/providers/. Null '
    'until the organisation''s product ids are seeded (TAR-617).';

-- ---------------------------------------------------------------------------
-- 2. `subscriptions` gains provider-period and cancellation detail (delta 2)
-- ---------------------------------------------------------------------------
--
-- `last_event_at` is the one that earns its place beyond record-keeping. Polar
-- retries with exponential backoff and guarantees no ordering, so a retried
-- `subscription.past_due` can be delivered after a fresh `subscription.active`.
-- Applied naively that walks a recovered tenant back into dunning, and the only
-- evidence left behind is a lifecycle row nobody can explain. The worker
-- compares the provider's `webhook-timestamp` against this column and drops what
-- is older.
--
-- It is deliberately not `updated_at`: that is our write clock, and comparing a
-- provider timestamp against it compares two clocks that were never
-- synchronised.

ALTER TABLE "public"."subscriptions"
    ADD COLUMN IF NOT EXISTS "cancels_at"     TIMESTAMPTZ(3),
    ADD COLUMN IF NOT EXISTS "past_due_since" TIMESTAMPTZ(3),
    ADD COLUMN IF NOT EXISTS "last_event_at"  TIMESTAMPTZ(3);

COMMENT ON COLUMN "public"."subscriptions"."cancels_at" IS
    'When a requested cancellation takes effect. The tenant has paid through this '
    'date and stays serviceable until it — a cancellation request is not a '
    'cancellation, and writes no lifecycle transition.';

COMMENT ON COLUMN "public"."subscriptions"."past_due_since" IS
    'When the provider first reported past_due. Support and reporting only. The '
    'dunning clock is tenants.grace_period_ends_at — this column must never become '
    'a second deadline.';

COMMENT ON COLUMN "public"."subscriptions"."last_event_at" IS
    'Provider timestamp of the last webhook that wrote this row. Out-of-order '
    'defence: an older event updates neither this table nor tenant_entitlements, '
    'and is marked processed.';

-- ---------------------------------------------------------------------------
-- 3. `plans.entitlements` takes the shape it is copied into
-- ---------------------------------------------------------------------------
--
-- ⚠️ **Not in the contract's delta list.** The contract says everything else in
-- `plans` "stands as migrated". It does not, and decision 4 is what breaks it.
--
-- Decision 4 rules that a plan's entitlements are **copied** into
-- `tenant_entitlements.entitlements` inside the transaction that applies a
-- subscription change. That destination is shape-checked by
-- `tenant_entitlements_shape`, which requires
-- `{ features: [], limits: { seats, conversationsPerPeriod, whatsappNumbers,
-- teams, knowledgeDocuments } }` with all five limit keys present.
--
-- `plans.entitlements` holds a flat `{ seats, conversationsPerPeriod }` — the
-- shape `DEMO_PLANS` seeds. Copying it as decision 4 requires would violate the
-- destination's CHECK and abort the activation transaction: the first tenant to
-- complete checkout would pay Polar and fail to be activated, and the webhook
-- would retry into the same failure ten times until Polar disabled the endpoint.
-- That is a production incident on the happy path, so the reshape lands here
-- rather than being discovered in TAR-618.
--
-- The second, quieter half of the same mismatch: `PlanFeaturesService` reads
-- feature flags **flat** off this column (`entitlements['workflows'] === true`)
-- while `PlanEntitlementsSchema` puts them in a `features` array. Its own doc
-- comment records that no seeded plan carries flags yet and that the absent
-- answer therefore grants, "when TAR-37 lands with real plan data" being the
-- named moment that stops. This is that moment — so `readFeatureFlag` must move
-- to reading `features[]`. That is application code and belongs to TAR-618; it
-- is flagged on the issue, not changed here.
--
-- **Until that one-function change lands, feature gating still grants
-- everything** — the flat lookup finds nothing in the new shape and falls
-- through to its existing `?? true`. That is the same behaviour as before this
-- migration, not a new hole, and it fails in the safe direction: a commercial
-- ceiling stays open, and tenant isolation is RLS's job and is untouched.

-- 3a. Reshape in place, preserving both existing values.
--
-- `whatsappNumbers`, `teams` and `knowledgeDocuments` have never existed on a
-- plan row, so there is no value to preserve and no honest way to invent one.
-- They are backfilled per tier from the figures `tenant_entitlements`'s own
-- default already publishes for `starter`, and scaled for the tiers above it.
-- Every one of these numbers is a placeholder — contract open question 6 says
-- the tier figures are a pricing decision that has not been made, and records
-- that they are seed data precisely so that settling them is not a migration.
--
-- A plan key this migration does not know gets its two real limits carried over,
-- the three new ones null (unlimited), and no features. Null is the right
-- unknown here: refusing on a ceiling nobody has set would cap a tenant an
-- operator deliberately provisioned outside the catalogue.

UPDATE "public"."plans" SET "entitlements" = jsonb_build_object(
    'features',
    CASE "key"
        WHEN 'starter' THEN '["assignment_rules","sla_policies"]'::jsonb
        WHEN 'growth'  THEN '["assignment_rules","sla_policies","workflows","advanced_reporting","api_access"]'::jsonb
        WHEN 'scale'   THEN '["assignment_rules","sla_policies","workflows","advanced_reporting","api_access","ai_chatbot","custom_branding","custom_domain"]'::jsonb
        ELSE '[]'::jsonb
    END,
    'limits', jsonb_build_object(
        -- Carried across verbatim where the old shape had them, so no priced
        -- ceiling changes value in either direction.
        'seats',                  "entitlements" -> 'seats',
        'conversationsPerPeriod', "entitlements" -> 'conversationsPerPeriod',
        'whatsappNumbers', CASE "key"
            WHEN 'starter' THEN '1'::jsonb
            WHEN 'growth'  THEN '3'::jsonb
            WHEN 'scale'   THEN '10'::jsonb
            ELSE 'null'::jsonb END,
        'teams', CASE "key"
            WHEN 'starter' THEN '2'::jsonb
            WHEN 'growth'  THEN '10'::jsonb
            WHEN 'scale'   THEN '50'::jsonb
            ELSE 'null'::jsonb END,
        'knowledgeDocuments', CASE "key"
            WHEN 'starter' THEN '10'::jsonb
            WHEN 'growth'  THEN '100'::jsonb
            WHEN 'scale'   THEN '1000'::jsonb
            ELSE 'null'::jsonb END
    )
)
-- Idempotent: a row already in the new shape is skipped, so a partly-applied
-- run or a hand replay does not nest `limits` inside `limits`.
--
-- The `jsonb_exists` guards are not decoration. `->` on an absent key yields SQL
-- NULL, `jsonb_typeof(NULL)` is NULL, and `NOT (NULL = 'object' AND …)` is NULL
-- rather than TRUE — so the obvious form of this predicate matches **no rows at
-- all**, and matches none precisely for the flat rows this statement exists to
-- convert. `jsonb_exists` returns a real boolean, which collapses the unknown
-- back to FALSE and makes `NOT` behave.
WHERE NOT (
    jsonb_exists("entitlements", 'limits')
    AND jsonb_typeof("entitlements" -> 'limits') = 'object'
    AND jsonb_exists("entitlements", 'features')
    AND jsonb_typeof("entitlements" -> 'features') = 'array'
);

-- A plan row whose old shape was missing `seats` or `conversationsPerPeriod`
-- needs no normalising step: `->` yields SQL NULL for an absent key and
-- `jsonb_build_object` converts a SQL NULL argument to **JSON null**, which is
-- exactly the "unlimited" the CHECK below admits. The key is present and its
-- value is `null`, so both `jsonb_exists` and the `jsonb_typeof = 'null'` branch
-- are satisfied.
--
-- 3b. The backstop. It asserts the five limit keys are present and each is null
-- or a positive integer, and that `features` is an array. It cannot check the
-- feature *values* — `PlanEntitlementsSchema` at every write site is the actual
-- contract, and this is what stops a hand-edited catalogue row from becoming a
-- failed activation for every tenant that buys the tier.
--
-- It mirrors `tenant_entitlements_shape` in intent but **not** statement for
-- statement, and the difference is the point. A CHECK constraint refuses a row
-- only when it evaluates to FALSE; NULL passes. So the naive
-- `jsonb_typeof("entitlements" -> 'features') = 'array'` admits a row with no
-- `features` key at all — the absent key gives NULL, the comparison gives NULL,
-- and the constraint waves it through. That is exactly the flat legacy shape
-- this constraint exists to refuse, so the `jsonb_exists` guards below are load
-- bearing rather than belt-and-braces.
--
-- `tenant_entitlements_shape` has the same gap and is tightened in section 5.

ALTER TABLE "public"."plans"
    DROP CONSTRAINT IF EXISTS "plans_entitlements_shape";

ALTER TABLE "public"."plans"
    ADD CONSTRAINT "plans_entitlements_shape" CHECK (
        jsonb_typeof("entitlements") = 'object'
        AND jsonb_exists("entitlements", 'features')
        AND jsonb_typeof("entitlements" -> 'features') = 'array'
        AND jsonb_exists("entitlements", 'limits')
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

COMMENT ON COLUMN "public"."plans"."entitlements" IS
    'PlanEntitlementsSchema: { features: PlanFeature[], limits: { seats, '
    'conversationsPerPeriod, whatsappNumbers, teams, knowledgeDocuments } }. Same '
    'shape as tenant_entitlements.entitlements, which decision 4 copies it into. '
    'A null limit means unlimited. plans_entitlements_shape is the backstop; the '
    'Zod schema at each write site is the contract.';

-- ---------------------------------------------------------------------------
-- 4. `subscription_status.cancelled` → `canceled`
-- ---------------------------------------------------------------------------
--
-- ⚠️ **Also not in the delta list, and it contradicts one.** Contract delta 3
-- states the enum "matches `SUBSCRIPTION_STATUSES` in the contract. No change."
-- It does not match: `SUBSCRIPTION_STATUSES` publishes `canceled` with one `l`
-- and this type was created with two. `BillingEvent.status` is typed
-- `SubscriptionStatusSchema`, so TAR-618 writing an event's status straight into
-- this column — which is the whole point of the two vocabularies agreeing — gets
-- an invalid input value for enum on the first cancellation it handles.
--
-- Renaming the label is the smaller of the two repairs. Nothing writes this
-- column: `BillingProvider` has no implementation, no seed sets a subscription
-- status, and the only `cancelled` in application code is `TenantStatus`, a
-- different enum this does not touch. The alternative — changing
-- `SUBSCRIPTION_STATUSES` to the double `l` — edits a published contract that
-- TAR-619 is already building its frontend against.
--
-- The two spellings that remain are deliberate and worth stating once, because
-- the next reader will assume one of them is a typo: `subscription_status.
-- canceled` is the **provider's** state, `tenant_status.cancelled` is **ours**,
-- and decision 5 turns entirely on their being different facts — a Polar
-- `subscription.canceled` must not lock a tenant out of a period it has paid
-- for. `BILLING_EVENT_TARGETS` translates between them explicitly.
--
-- Recorded for the Architect to confirm; reverting is one statement either way.
--
-- `RENAME VALUE` is catalogue-only — it rewrites no row and, unlike `ADD VALUE`,
-- is safe inside the transaction Prisma wraps this file in.
--
-- Guarded because `RENAME VALUE` has no `IF EXISTS` form and errors on a label
-- that is already renamed, which would make a replay of this file fail on a
-- database that is already correct. Every other statement here carries
-- `IF NOT EXISTS` for the same reason; this is that, spelled the long way.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'subscription_status' AND e.enumlabel = 'cancelled'
    ) THEN
        ALTER TYPE "public"."subscription_status" RENAME VALUE 'cancelled' TO 'canceled';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. `tenant_entitlements_shape` stops passing rows it was written to refuse
-- ---------------------------------------------------------------------------
--
-- ⚠️ **Not in the delta list either**, and the reason it belongs in this
-- migration rather than a later one is decision 4: that constraint is the
-- backstop the entitlement copy relies on, and this is the release that starts
-- copying into it.
--
-- The gap is the one section 3b describes. A CHECK refuses a row only when it
-- evaluates to FALSE, and NULL is not FALSE. Every clause of the original is a
-- comparison against `jsonb_typeof(... -> key)`, which yields NULL when the key
-- is absent — so `{}` satisfies `tenant_entitlements_shape` today, as does any
-- object missing `features`, missing `limits`, or missing all five limit keys.
-- The constraint asserts the *types* of the keys that happen to be there; it was
-- meant to assert they are there at all.
--
-- Harmless while the only writer was the column default. Not harmless now: the
-- copy takes whatever `plans.entitlements` holds and writes it here, and a
-- malformed catalogue row would land silently and then be read as "no ceilings"
-- by `PlanLimitsService` — which is the failure direction that gives a tenant
-- more than it paid for, discovered at the invoice.
--
-- `jsonb_exists` returns a real boolean for an absent key, which is the whole
-- fix. Every other clause is reproduced verbatim.
--
-- Safe to tighten: every existing row was written either by the column default
-- or by a path that already produced the full shape, so nothing on disk is
-- refused by the stricter form. `ADD CONSTRAINT` validates existing rows as it
-- runs, so a row that does violate it fails this migration loudly here rather
-- than failing an activation quietly later — which is the outcome to want.

ALTER TABLE "public"."tenant_entitlements"
    DROP CONSTRAINT IF EXISTS "tenant_entitlements_shape";

ALTER TABLE "public"."tenant_entitlements"
    ADD CONSTRAINT "tenant_entitlements_shape" CHECK (
        jsonb_typeof("entitlements") = 'object'
        AND jsonb_exists("entitlements", 'features')
        AND jsonb_typeof("entitlements" -> 'features') = 'array'
        AND jsonb_exists("entitlements", 'limits')
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
