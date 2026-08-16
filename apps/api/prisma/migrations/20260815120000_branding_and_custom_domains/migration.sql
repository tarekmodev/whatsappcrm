-- Branding assets and custom-domain verification (TAR-417).
--
-- The schema half of TAR-29, implementing the "Data Model" section of TAR-416's
-- contract. No new table: `tenant_branding` and `tenant_domains` both landed with
-- 20260810130000_initial_data_model and both already carry a `tenant_isolation`
-- policy from 20260810140000_tenant_isolation_rls. This is the delta.
--
--   1. `tenant_domains` gains the six columns a DNS ownership challenge needs,
--      plus the two indexes and the check constraint that make the claim rules
--      the database's job rather than the service's.
--   2. `tenant_branding` gains four columns per asset — logo and favicon — and
--      loses `logo_url` / `favicon_url`, which nothing has ever written.
--   3. Four check constraints on `tenant_branding`, so a half-written asset or a
--      malformed colour cannot reach the CSS derivation.
--
-- ---------------------------------------------------------------------------
-- Why a storage key and not a URL
-- ---------------------------------------------------------------------------
--
-- `logo_url`/`favicon_url` were declared in the initial data model and never
-- written by anything — no service, no seed, no backfill (grep for either name:
-- `schema.prisma` and the initial migration are the only hits). TAR-416 replaces
-- their intent rather than filling them in, because a stored absolute URL names
-- whichever host existed at write time, and the *same row* is served under a
-- tenant's platform subdomain and under its custom domain. Under the other host
-- the browser then fetches cross-origin, and 0002 decision 3 is that a
-- cross-origin request drops the session cookie. What goes on the wire is the
-- relative path `brandingAssetPath()` builds; what is stored is the key into the
-- `MediaStorage` port.
--
-- Four columns per asset rather than one JSON blob because `logo_size_bytes` is
-- a number an operator sums per tenant, `logo_mime_type` is the response's
-- `Content-Type`, `logo_updated_at` is the `?v=` cache-buster — and because a
-- check constraint can then require the group to be all-null or all-set, which
-- is the property that stops a row pointing at bytes with no type to serve them
-- as.
--
-- ---------------------------------------------------------------------------
-- The drop is verified empty, not assumed empty
-- ---------------------------------------------------------------------------
--
-- Dropping a column destroys the data in it, and `docs/runbooks/migrations.md`
-- is explicit that where that is unacceptable the answer is expand → migrate →
-- contract rather than a better `down.sql`. It is acceptable here for one
-- reason, and the migration asserts that reason instead of trusting it: the
-- precondition block below counts rows with a non-null `logo_url` or
-- `favicon_url` and **aborts the migration** if it finds any. Both columns are
-- provably all-NULL, so the drop destroys nothing and `down.sql` restores the
-- exact prior shape losslessly.
--
-- If that count ever fires, do not weaken the check. Ship the eight new columns
-- on their own, backfill the bytes into the `MediaStorage` port through the
-- application, and drop these two in a separate later migration.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds in every environment this will reach.
--                `tenant_branding` holds at most one row per tenant and
--                `tenant_domains` at most six (one platform subdomain plus
--                `MAX_CUSTOM_DOMAINS_PER_TENANT = 5`), so both are bounded by
--                the tenant count — low hundreds at the scale 0002 targets, not
--                by traffic.
--
--                How the statements age, since that is the part a row count
--                changes:
--
--                  * every `ADD COLUMN` here is nullable or `NOT NULL DEFAULT 0`
--                    with a constant default, so all of them are metadata-only in
--                    PostgreSQL 11+ — no table rewrite at 10 rows or 10 million.
--                  * `DROP COLUMN` is also metadata-only; the space returns on
--                    the next `VACUUM FULL`, which is not scheduled and does not
--                    need to be.
--                  * the two index builds and the six `ADD CONSTRAINT ... CHECK`
--                    validations are the parts that scale, and both are correct
--                    non-concurrently only because the tables are small. On a
--                    table where they were not, the index goes into its own
--                    migration as `CREATE INDEX CONCURRENTLY` outside a
--                    transaction, and each constraint is added `NOT VALID` and
--                    validated in a second step — neither of which is expressible
--                    inside the single transaction Prisma wraps a migration in.
--
--   Locks        ACCESS EXCLUSIVE on `tenant_branding` and on `tenant_domains`,
--                held to commit. Both are read by `HostTenantGuard` on every
--                request, which is exactly why `lock_timeout` is set below.
--
--   Blocking     `lock_timeout = '3s'` caps the wait, so a conflicting
--                long-running transaction aborts this migration cleanly rather
--                than queueing ahead of every host lookup on the system. Re-run
--                once it clears. While the lock is held, host → tenant
--                resolution blocks — that is a whole-platform pause, so this is
--                the one migration in the set that should not be applied during
--                a traffic peak. At millisecond duration the practical exposure
--                is a few requests' latency.
--
--   Data loss    Two columns dropped, both asserted empty first (above). Nothing
--                else is dropped, narrowed or retyped, and there is no backfill.
--
--   Rollback     `down.sql` beside this file. Lossless, because the columns it
--                re-creates were empty when this dropped them.
--
-- ---------------------------------------------------------------------------
-- Additive and re-runnable
-- ---------------------------------------------------------------------------
--
-- Prisma runs a migration in one transaction and records it in
-- `_prisma_migrations`, so `migrate deploy` re-running it is already a no-op at
-- the runner level. TAR-417 asks for idempotence at the file level too, so every
-- statement here converges rather than erroring on a second application: the
-- enum is created behind a catalogue check, columns use `IF NOT EXISTS` /
-- `IF EXISTS`, indexes use `IF NOT EXISTS`, and each constraint is dropped
-- `IF EXISTS` immediately before it is added — invisibly, since the whole file is
-- one transaction. The precondition block is written to give the same answer on
-- a first run and on a replay, when the columns it interrogates have already
-- changed shape.
--
-- **No `pnpm db:roles` re-run is needed.** It is required for a migration that
-- adds a table or a function; this adds neither. Grants in `app-roles.sql` are
-- table-level, and a table-level grant covers columns added later, so
-- `whatsappcrm_app` reaches the new columns with no change. RLS is untouched:
-- both tables keep the `tenant_isolation` policy and the `FORCE` they already
-- had, and `pnpm db:verify:rls` reads the catalogue rather than a list, so it
-- proves that rather than taking this comment's word for it.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Preconditions, before the statements that depend on them
-- ---------------------------------------------------------------------------
--
-- Three claims this migration makes about existing data. Each is asserted rather
-- than believed, and each failure message names the fix.
--
-- The `NO FORCE ROW LEVEL SECURITY` toggle is the manoeuvre TAR-52, TAR-92 and
-- 20260813130000 all use, and without it these counts are a rubber stamp: the
-- migration owner is **not** exempt from `FORCE`, no `app.tenant_id` GUC is set
-- during a migration, so `tenant_isolation` matches nothing and every count
-- below would report 0 on a table full of rows. Safe inline — DDL is
-- transactional in PostgreSQL, the `ALTER TABLE`s below take ACCESS EXCLUSIVE on
-- the same tables moments later, and an abort rolls the toggle back with
-- everything else.
--
-- Every read is through `EXECUTE`, because PL/pgSQL plans a static statement
-- when its branch first runs and half of these name columns that exist on a
-- replay but not on a first run (or the reverse).
DO $precondition$
DECLARE
    stale_assets     bigint := 0;
    extra_primaries  bigint := 0;
    unconstrainable  bigint := 0;
    has_legacy_urls  boolean;
    has_token_column boolean;
BEGIN
    EXECUTE 'ALTER TABLE "public"."tenant_branding" NO FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."tenant_domains" NO FORCE ROW LEVEL SECURITY';

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tenant_branding'
          AND column_name = 'logo_url'
    ) INTO has_legacy_urls;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tenant_domains'
          AND column_name = 'verification_token'
    ) INTO has_token_column;

    -- 1. The two columns about to be dropped carry nothing. On a replay they are
    --    already gone, which answers the same question.
    IF has_legacy_urls THEN
        EXECUTE '
            SELECT count(*) FROM "public"."tenant_branding"
            WHERE "logo_url" IS NOT NULL OR "favicon_url" IS NOT NULL
        ' INTO stale_assets;
    END IF;

    -- 2. No tenant already holds two primary domains. Without this the unique
    --    index build below fails with a bare duplicate-key error naming a value,
    --    not a tenant and not a remedy.
    EXECUTE '
        SELECT count(*) FROM (
            SELECT "tenant_id" FROM "public"."tenant_domains"
            WHERE "is_primary"
            GROUP BY "tenant_id" HAVING count(*) > 1
        ) AS duplicated
    ' INTO extra_primaries;

    -- 3. No existing custom domain would violate `tenant_domains_custom_needs_token`.
    --    Before this migration there is no verification path at all, so every
    --    custom row is one; after it, only a tokenless one is.
    IF has_token_column THEN
        EXECUTE '
            SELECT count(*) FROM "public"."tenant_domains"
            WHERE "kind" = ''custom'' AND "verification_token" IS NULL
        ' INTO unconstrainable;
    ELSE
        EXECUTE '
            SELECT count(*) FROM "public"."tenant_domains" WHERE "kind" = ''custom''
        ' INTO unconstrainable;
    END IF;

    EXECUTE 'ALTER TABLE "public"."tenant_branding" FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."tenant_domains" FORCE ROW LEVEL SECURITY';

    IF stale_assets > 0 THEN
        RAISE EXCEPTION
            'tenant_branding holds % row(s) with a non-null logo_url or favicon_url. '
            'This migration drops both columns, which would destroy that data. Ship '
            'the eight new asset columns on their own, move the bytes into the '
            'MediaStorage port through the application, and drop these two in a '
            'later migration.', stale_assets;
    END IF;

    IF extra_primaries > 0 THEN
        RAISE EXCEPTION
            '% tenant(s) hold more than one primary domain. tenant_domains_one_primary '
            'below makes that impossible, so pick the intended primary per tenant and '
            'clear is_primary on the others before re-applying.', extra_primaries;
    END IF;

    IF unconstrainable > 0 THEN
        RAISE EXCEPTION
            'tenant_domains holds % custom domain(s) with no verification token. '
            'Nothing could have verified them — there was no verification path before '
            'this migration — so they resolve to nothing today. Delete them, or issue '
            'each a token, before re-applying.', unconstrainable;
    END IF;
END
$precondition$;

-- ---------------------------------------------------------------------------
-- Schema change. Generated by `prisma migrate diff`, then made re-runnable and
-- read before committing.
-- ---------------------------------------------------------------------------

-- CreateEnum
--
-- `CREATE TYPE` has no `IF NOT EXISTS`, so the catalogue answers instead. The
-- values are exactly `DOMAIN_VERIFICATION_FAILURE_REASONS` in
-- `packages/contracts/src/tenant.ts`; the column value is read straight onto the
-- wire, so there is no mapping layer for the two to drift through.
DO $failure_reason$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'tenant_domain_verification_failure_reason'
    ) THEN
        CREATE TYPE "public"."tenant_domain_verification_failure_reason"
            AS ENUM ('record_not_found', 'record_mismatch', 'lookup_failed', 'lookup_timeout');
    END IF;
END
$failure_reason$;

-- AlterTable
ALTER TABLE "public"."tenant_branding"
    DROP COLUMN IF EXISTS "logo_url",
    DROP COLUMN IF EXISTS "favicon_url",
    ADD COLUMN IF NOT EXISTS "logo_storage_key" TEXT,
    ADD COLUMN IF NOT EXISTS "logo_mime_type" TEXT,
    ADD COLUMN IF NOT EXISTS "logo_size_bytes" INTEGER,
    ADD COLUMN IF NOT EXISTS "logo_updated_at" TIMESTAMPTZ(3),
    ADD COLUMN IF NOT EXISTS "favicon_storage_key" TEXT,
    ADD COLUMN IF NOT EXISTS "favicon_mime_type" TEXT,
    ADD COLUMN IF NOT EXISTS "favicon_size_bytes" INTEGER,
    ADD COLUMN IF NOT EXISTS "favicon_updated_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "public"."tenant_domains"
    ADD COLUMN IF NOT EXISTS "verification_token" TEXT,
    ADD COLUMN IF NOT EXISTS "verification_requested_at" TIMESTAMPTZ(3),
    ADD COLUMN IF NOT EXISTS "verification_last_checked_at" TIMESTAMPTZ(3),
    ADD COLUMN IF NOT EXISTS "verification_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "verification_failure_reason"
        "public"."tenant_domain_verification_failure_reason",
    ADD COLUMN IF NOT EXISTS "activated_at" TIMESTAMPTZ(3);

-- ---------------------------------------------------------------------------
-- Constraints and indexes Prisma cannot express
-- ---------------------------------------------------------------------------
--
-- Prisma's schema language has no syntax for a CHECK constraint or a partial
-- index, and its PostgreSQL describer skips predicated indexes — so `migrate dev`
-- will neither generate what follows nor propose to drop it, and its absence is
-- never reported as drift. **Nothing in `schema.prisma` will ever regenerate
-- these.** They are noted in comments on both models and asserted against a real
-- database by `src/prisma/tenant-branding-domains.int-spec.ts`, which is the only
-- thing that notices if one goes missing. A missing constraint does not fail
-- loudly; it silently starts accepting rows it should not.
--
-- Each constraint is dropped `IF EXISTS` and re-added rather than guarded by a
-- catalogue lookup. It reads as the DDL it is, and the momentary gap is invisible
-- because the whole file is one transaction.

-- AddCheckConstraint
--
-- An asset is four columns, and they are meaningful only together: a row naming
-- a storage key with no mime type is a logo the serve route cannot set a
-- `Content-Type` for, and a row with a `logo_updated_at` and no key is a
-- cache-buster pointing at nothing. All four null (no asset) or all four set.
ALTER TABLE "public"."tenant_branding"
    DROP CONSTRAINT IF EXISTS "tenant_branding_logo_complete";
ALTER TABLE "public"."tenant_branding"
    ADD CONSTRAINT "tenant_branding_logo_complete" CHECK (
        num_nonnulls("logo_storage_key", "logo_mime_type", "logo_size_bytes", "logo_updated_at")
            IN (0, 4)
    );

ALTER TABLE "public"."tenant_branding"
    DROP CONSTRAINT IF EXISTS "tenant_branding_favicon_complete";
ALTER TABLE "public"."tenant_branding"
    ADD CONSTRAINT "tenant_branding_favicon_complete" CHECK (
        num_nonnulls("favicon_storage_key", "favicon_mime_type", "favicon_size_bytes",
                     "favicon_updated_at")
            IN (0, 4)
    );

-- AddCheckConstraint
--
-- `#rrggbb`, matching `HexColorSchema` in `packages/contracts/src/common.ts`
-- exactly — six digits, either case, no three-digit shorthand and no bare name.
-- Null stays legal and means "not customised": `BRANDING_DEFAULTS` fills it, and
-- a `NOT NULL DEFAULT` here would bake the platform's own brand into every row.
--
-- Worth the duplication with the Zod schema because these two values are the
-- input to the WCAG AA derivation in `brandCssVariables()`. A malformed colour
-- does not fail there — it produces a contrast ratio computed from garbage, and
-- the guarantee 0001 measures quietly stops holding.
ALTER TABLE "public"."tenant_branding"
    DROP CONSTRAINT IF EXISTS "tenant_branding_primary_color_hex";
ALTER TABLE "public"."tenant_branding"
    ADD CONSTRAINT "tenant_branding_primary_color_hex" CHECK (
        "primary_color" IS NULL OR "primary_color" ~ '^#[0-9A-Fa-f]{6}$'
    );

ALTER TABLE "public"."tenant_branding"
    DROP CONSTRAINT IF EXISTS "tenant_branding_accent_color_hex";
ALTER TABLE "public"."tenant_branding"
    ADD CONSTRAINT "tenant_branding_accent_color_hex" CHECK (
        "accent_color" IS NULL OR "accent_color" ~ '^#[0-9A-Fa-f]{6}$'
    );

-- AddCheckConstraint
--
-- A platform subdomain is ours to issue under our own zone and has nothing for
-- the customer to prove, so it carries no token. A custom domain always does —
-- the token is what makes `verified_at` meaningful, and a custom row without one
-- could only be verified by something other than a DNS challenge.
--
-- Stated as `kind = 'platform' OR ...` rather than as two branches so that a
-- third `tenant_domain_kind` value, if one is ever added, has to come back here
-- and say which side it is on.
ALTER TABLE "public"."tenant_domains"
    DROP CONSTRAINT IF EXISTS "tenant_domains_custom_needs_token";
ALTER TABLE "public"."tenant_domains"
    ADD CONSTRAINT "tenant_domains_custom_needs_token" CHECK (
        "kind" = 'platform' OR "verification_token" IS NOT NULL
    );

-- AddCheckConstraint
--
-- 32 lowercase hex characters, per TAR-416. The format is pinned in the database
-- because the token's only job is to be unguessable: a short or empty one makes
-- the DNS challenge trivially forgeable by whoever controls *any* zone, and that
-- forges ownership of a hostname rather than merely looking wrong. Changing the
-- length later is a migration, deliberately.
--
-- Not unique, and not hashed. It is published in public DNS by the tenant, so it
-- is not a credential; TAR-416 records the reasoning and `schema.prisma` repeats
-- it beside the column.
ALTER TABLE "public"."tenant_domains"
    DROP CONSTRAINT IF EXISTS "tenant_domains_verification_token_format";
ALTER TABLE "public"."tenant_domains"
    ADD CONSTRAINT "tenant_domains_verification_token_format" CHECK (
        "verification_token" IS NULL OR "verification_token" ~ '^[0-9a-f]{32}$'
    );

-- CreateIndex
--
-- Exactly one primary domain per tenant. `TenantLinkService.primaryHostname()`
-- already reads it to build invite and password-reset links, so two primaries
-- makes which host a recipient is sent to depend on row order — and the link
-- carries a live token, which is why that service's own docstring treats the
-- primary hostname as security-relevant rather than cosmetic.
--
-- Partial rather than `UNIQUE (tenant_id, is_primary)`: the constraint is on the
-- `true` rows only, and a tenant may hold any number of non-primary domains.
-- Leading with `tenant_id` and nothing else because that *is* the whole key —
-- one row per tenant among the primaries.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_domains_one_primary"
    ON "public"."tenant_domains" ("tenant_id")
    WHERE "is_primary";

-- CreateIndex
--
-- The verification sweeper's work queue: pending claims, oldest first, so the
-- re-check pass and the seven-day squat expiry both read an index rather than
-- scanning `tenant_domains`.
--
-- Deliberately does not lead with `tenant_id`, and 0002's rule 3 is knowingly
-- excepted here for the same reason `sla_timers_state_due_at_idx` excepts it
-- (20260813130000): the sweeper runs in a job with no request context, so its
-- predicate carries no tenant term at all and a `(tenant_id, ...)` index would
-- leave the planner a full scan. It serves a read; every write the sweeper then
-- performs is per tenant and under RLS.
--
-- `WHERE verified_at IS NULL` is the whole point of the predicate: a verified
-- domain leaves the index instead of sitting in it, and platform subdomains —
-- verified at provisioning — never enter it at all. The index therefore holds
-- only rows the sweeper actually has work for, which is normally none.
CREATE INDEX IF NOT EXISTS "tenant_domains_unverified"
    ON "public"."tenant_domains" ("verification_requested_at")
    WHERE "verified_at" IS NULL;
