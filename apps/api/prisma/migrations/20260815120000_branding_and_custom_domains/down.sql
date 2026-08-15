-- Reverses 20260815120000_branding_and_custom_domains.
--
-- Returns `tenant_branding` and `tenant_domains` to exactly the shape
-- 20260810140000_tenant_isolation_rls left them in: the fourteen new columns
-- go, the six check constraints and two indexes with them, the enum type is
-- dropped, and `logo_url` / `favicon_url` come back as nullable `text`.
--
-- **Lossless in the direction that matters.** The up migration refuses to run
-- while any row carries a non-null `logo_url` or `favicon_url`, so re-creating
-- them empty restores the prior state exactly rather than approximately. The
-- other direction is not lossless and cannot be: this drops branding assets and
-- every custom-domain verification claim. See "What it costs" below before
-- running it against anything but a local database.
--
-- ---------------------------------------------------------------------------
-- What it costs
-- ---------------------------------------------------------------------------
--
-- * Any logo or favicon a tenant has uploaded becomes unreachable. The **bytes
--   survive** — they live in the `MediaStorage` port under
--   `tenants/<tenantId>/branding/<storageId>`, not in the database — but the
--   keys that name them are in the columns this drops, so nothing can find them
--   again. Read those four columns out to a file first if the assets matter.
-- * Every custom domain loses its verification token, its attempt history and
--   its `activated_at`. The rows themselves survive with `verified_at` intact,
--   so a domain that was already verified keeps resolving; one still pending
--   loses its challenge and its tenant must claim it again, with a new token and
--   a new TXT record.
-- * `tenant_domains_one_primary` goes, and with it the guarantee that
--   `TenantLinkService.primaryHostname()` has one answer. Nothing re-creates it:
--   Prisma cannot express a partial index and its describer skips predicated
--   ones, so a re-apply means running `migration.sql` again.
-- * `tenant-branding-domains.int-spec.ts` fails once this is applied, which is
--   that spec working rather than an obstacle.
--
-- Rolling the *application* back does not need any of this. Every column here is
-- additive, so the previous release runs against the new schema unchanged —
-- which is the point of the additive rule and the reason this file should stay
-- unused.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Metadata-only column drops, two index drops, six
--                constraint drops and one enum drop; no table rewrite, no scan.
--   Locks        ACCESS EXCLUSIVE on both tables, held to commit. `lock_timeout`
--                caps the wait at three seconds so this aborts cleanly rather
--                than queueing ahead of every host lookup.
--   Data loss    Yes, as itemised above.
--   Re-runnable  Every statement is `IF EXISTS` / `IF NOT EXISTS` guarded, so a
--                second application is a no-op rather than an error.
--
-- No `pnpm db:roles` re-run is needed in either direction: no table and no
-- function changes hands, and grants are table-level. RLS is untouched — both
-- tables keep the `tenant_isolation` policy and the `FORCE` flag they had before
-- the up migration and still have after it.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is also applied by hand through `psql`, which is in autocommit. One outermost
-- `BEGIN;` … `COMMIT;` with nothing after it, which is the shape
-- `db:check-migrations` requires and `db:rollback` can batch with its
-- `_prisma_migrations` delete.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- DropIndex
DROP INDEX IF EXISTS "public"."tenant_domains_unverified";
DROP INDEX IF EXISTS "public"."tenant_domains_one_primary";

-- DropCheckConstraint
--
-- Dropped explicitly rather than left to cascade from the columns below, so that
-- this file states everything it removes instead of removing things a reader has
-- to infer.
ALTER TABLE "public"."tenant_domains"
    DROP CONSTRAINT IF EXISTS "tenant_domains_verification_token_format";
ALTER TABLE "public"."tenant_domains"
    DROP CONSTRAINT IF EXISTS "tenant_domains_custom_needs_token";
ALTER TABLE "public"."tenant_branding"
    DROP CONSTRAINT IF EXISTS "tenant_branding_accent_color_hex";
ALTER TABLE "public"."tenant_branding"
    DROP CONSTRAINT IF EXISTS "tenant_branding_primary_color_hex";
ALTER TABLE "public"."tenant_branding"
    DROP CONSTRAINT IF EXISTS "tenant_branding_favicon_complete";
ALTER TABLE "public"."tenant_branding"
    DROP CONSTRAINT IF EXISTS "tenant_branding_logo_complete";

-- AlterTable
ALTER TABLE "public"."tenant_domains"
    DROP COLUMN IF EXISTS "activated_at",
    DROP COLUMN IF EXISTS "verification_failure_reason",
    DROP COLUMN IF EXISTS "verification_attempts",
    DROP COLUMN IF EXISTS "verification_last_checked_at",
    DROP COLUMN IF EXISTS "verification_requested_at",
    DROP COLUMN IF EXISTS "verification_token";

-- AlterTable
--
-- `logo_url` and `favicon_url` return as nullable `text`, which is what they
-- were. The up migration proved them empty before dropping them, so restoring
-- them empty is a restoration and not an approximation.
ALTER TABLE "public"."tenant_branding"
    DROP COLUMN IF EXISTS "favicon_updated_at",
    DROP COLUMN IF EXISTS "favicon_size_bytes",
    DROP COLUMN IF EXISTS "favicon_mime_type",
    DROP COLUMN IF EXISTS "favicon_storage_key",
    DROP COLUMN IF EXISTS "logo_updated_at",
    DROP COLUMN IF EXISTS "logo_size_bytes",
    DROP COLUMN IF EXISTS "logo_mime_type",
    DROP COLUMN IF EXISTS "logo_storage_key",
    ADD COLUMN IF NOT EXISTS "logo_url" TEXT,
    ADD COLUMN IF NOT EXISTS "favicon_url" TEXT;

-- DropEnum
--
-- After the column that uses it, or the drop fails on the dependency. `IF EXISTS`
-- rather than a catalogue check because `DROP TYPE` supports it, unlike
-- `CREATE TYPE`.
DROP TYPE IF EXISTS "public"."tenant_domain_verification_failure_reason";

COMMIT;
