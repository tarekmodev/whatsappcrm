-- WhatsApp Business Account as a first-class entity (TAR-52).
--
-- TAR-47 modelled the WhatsApp channel against the assumption on the table at
-- the time: one WABA per tenant. TAR-39's question 6 has since been answered —
-- a tenant may hold one *or more* WABAs — so this migration splits the level
-- that assumption collapsed. It is a follow-up to TAR-47, not a defect in it.
--
-- Meta scopes three levels, and now so does the schema:
--
--   tenants ──< whatsapp_business_accounts   waba_id, access token, verification
--                   ├──< whatsapp_accounts   phone_number_id, quality rating
--                   └──< message_templates   name, language, approval status
--
-- ---------------------------------------------------------------------------
-- Directory name: 160000, which is BEFORE 20260810170000_harden_tenant_
-- deactivation_guard on main
-- ---------------------------------------------------------------------------
--
-- Deliberate, and coordinated: TAR-51's hardening migration took 170000 rather
-- than 160000 precisely to leave this slot for this branch, and says so in its
-- commit message. Keeping 160000 honours that rather than silently leaving a gap.
--
-- It means a database that already applied 170000 gets this one out of order,
-- which is safe here because the two are independent — 170000 replaces the
-- `public.assert_tenant_active` function and touches no table; this one touches
-- three WhatsApp tables and no function. Neither reads what the other writes, so
-- either order produces the same schema. Verified both ways against a real
-- database before this was committed: a clean replay of all six in order, and
-- this one applied on top of a database already at 170000.
--
-- ---------------------------------------------------------------------------
-- What moves, and why each move is forced by Meta's own scoping
-- ---------------------------------------------------------------------------
--
--   access_token_encrypted
--     whatsapp_accounts → whatsapp_business_accounts. Meta issues the token to
--     the business. On the phone-number row, two numbers in one WABA store the
--     same secret twice and a rotation is an N-row update whose rows can drift
--     apart — the failure mode being one number that silently keeps sending
--     with a revoked credential. One row per WABA makes rotation atomic.
--
--   waba_id
--     Was a denormalised TEXT column on whatsapp_accounts; becomes the natural
--     key of the new table, UNIQUE **globally** on the same reasoning as
--     phone_number_id: one Meta app serves every tenant, so an id arriving on a
--     webhook has to resolve to exactly one row. whatsapp_accounts now reaches
--     it through whatsapp_business_account_id.
--
--   message_templates
--     Re-keyed from UNIQUE (tenant_id, name, language) to
--     UNIQUE (tenant_id, whatsapp_business_account_id, name, language). Meta
--     approves templates per WABA, so one tenant with two WABAs may hold
--     `order_update`/`en` in both — separate submissions, possibly different
--     content and different approval status. Under the old key the second
--     insert failed on a unique violation with no correct workaround.
--
--     The column is named whatsapp_business_account_id rather than waba_id (as
--     TAR-39's entity table writes it) because waba_id is Meta's external
--     string and now lives on the parent. One name, one meaning; the constraint
--     is the one TAR-39 specifies.
--
--   quality_rating
--     New, nullable, on whatsapp_accounts. Meta rates and throttles per number,
--     not per business, so two numbers under one WABA can sit at different
--     ratings. NULL means we have never read it; `unknown` is a value Meta
--     itself returns.
--
-- Dropped index: message_templates (tenant_id, whatsapp_account_id). The new
-- unique index leads with exactly (tenant_id, whatsapp_business_account_id), so
-- "every template in this WABA" already has an access path. A second index on
-- the same prefix costs write throughput and serves no read.
--
-- Also dropped: whatsapp_accounts (tenant_id). Its replacement,
-- (tenant_id, whatsapp_business_account_id), leads with the same column, and
-- the table's (tenant_id, id) unique index already covered a bare tenant_id
-- lookup.
--
-- ---------------------------------------------------------------------------
-- Why this is one migration and not expand → migrate → contract
-- ---------------------------------------------------------------------------
--
-- Because the tables are empty. No product data exists, TAR-20 has not started,
-- and nothing reads these columns yet. `ADD COLUMN ... NOT NULL` without a
-- default and `DROP COLUMN access_token_encrypted` are both correct only on
-- that assumption, so the guard below **verifies it instead of trusting it**:
-- against a database with even one row in either table this migration aborts
-- untouched, and the change has to be redone as expand → backfill → contract
-- with the token re-encrypted under the new row. That is the conversation the
-- guard is there to force, and it is much cheaper to have now than after a
-- DROP COLUMN has taken the only copy of a live access token with it.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Three tables, all empty; no rewrite, no backfill,
--                no index build over rows.
--   Locks        ACCESS EXCLUSIVE on whatsapp_accounts and message_templates,
--                held to commit (Prisma runs a migration in one transaction).
--                whatsapp_business_accounts does not exist until this runs, so
--                nothing can be waiting on it.
--   Blocking     lock_timeout caps the wait at three seconds, so a conflicting
--                long-running transaction aborts this migration cleanly rather
--                than queueing ahead of every new query. Re-run once it clears.
--   Data loss    Yes, if the guard is removed: DROP COLUMN access_token_encrypted
--                destroys the encrypted credential, and DROP COLUMN waba_id the
--                only link back to the business. The guard is what makes this
--                statement safe, not the ordering.
--   Rollback     `down.sql` beside this file. Reversible with no data loss while
--                the tables are empty, and only while they are.
--
-- After applying, re-run `pnpm db:roles`: whatsapp_business_accounts is a new
-- table and needs its grants and its `system_unrestricted` policy, neither of
-- which a migration can carry (see prisma/sql/app-roles.sql). `pnpm db:verify:rls`
-- fails by name until that is done.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Guard. Refuses to run against a database that has real WhatsApp rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    account_rows bigint;
    template_rows bigint;
BEGIN
    -- The migration owner is not exempt from FORCE ROW LEVEL SECURITY, and no
    -- GUC is set here, so a plain count would read zero on a full table and the
    -- guard would wave through exactly the case it exists to stop. Counting as
    -- the table owner with the policy suspended is the only reading that means
    -- anything.
    --
    -- Safe to do inline: DDL is transactional in Postgres, this migration holds
    -- ACCESS EXCLUSIVE on both tables for its whole duration so no other session
    -- can query them while FORCE is off, and an abort — including the RAISE
    -- below — rolls the toggle back with everything else.
    EXECUTE 'ALTER TABLE "public"."whatsapp_accounts" NO FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."message_templates" NO FORCE ROW LEVEL SECURITY';

    SELECT count(*) INTO account_rows FROM "public"."whatsapp_accounts";
    SELECT count(*) INTO template_rows FROM "public"."message_templates";

    EXECUTE 'ALTER TABLE "public"."whatsapp_accounts" FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."message_templates" FORCE ROW LEVEL SECURITY';

    IF account_rows > 0 OR template_rows > 0 THEN
        RAISE EXCEPTION
            'TAR-52 refuses to run: whatsapp_accounts has % row(s) and message_templates has % row(s)',
            account_rows, template_rows
            USING HINT =
                'This migration drops access_token_encrypted and waba_id outright, which is '
                'only safe while both tables are empty. With data present, redo it as expand '
                '-> backfill -> contract: add whatsapp_business_accounts, populate one row per '
                'distinct waba_id, re-encrypt the token onto it, dual-read, then drop the old '
                'columns in a separate deploy.';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Schema change. Generated by `prisma migrate diff`, read before committing.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "whatsapp_business_verification_status" AS ENUM ('not_verified', 'pending', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "whatsapp_quality_rating" AS ENUM ('green', 'yellow', 'red', 'unknown');

-- DropForeignKey
ALTER TABLE "message_templates" DROP CONSTRAINT "message_templates_tenant_id_whatsapp_account_id_fkey";

-- DropIndex
DROP INDEX "message_templates_tenant_id_name_language_key";

-- DropIndex
DROP INDEX "message_templates_tenant_id_whatsapp_account_id_idx";

-- DropIndex
DROP INDEX "whatsapp_accounts_tenant_id_idx";

-- AlterTable
ALTER TABLE "message_templates" DROP COLUMN "whatsapp_account_id",
ADD COLUMN     "whatsapp_business_account_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "whatsapp_accounts" DROP COLUMN "access_token_encrypted",
DROP COLUMN "waba_id",
ADD COLUMN     "quality_rating" "whatsapp_quality_rating",
ADD COLUMN     "whatsapp_business_account_id" UUID NOT NULL;

-- CreateTable
CREATE TABLE "whatsapp_business_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "waba_id" TEXT NOT NULL,
    "name" TEXT,
    "access_token_encrypted" TEXT,
    "verification_status" "whatsapp_business_verification_status" NOT NULL DEFAULT 'not_verified',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_business_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_business_accounts_waba_id_key" ON "whatsapp_business_accounts"("waba_id");

-- CreateIndex
CREATE INDEX "whatsapp_business_accounts_tenant_id_idx" ON "whatsapp_business_accounts"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_business_accounts_tenant_id_id_key" ON "whatsapp_business_accounts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_tenant_id_whatsapp_business_account_id_na_key" ON "message_templates"("tenant_id", "whatsapp_business_account_id", "name", "language");

-- CreateIndex
CREATE INDEX "whatsapp_accounts_tenant_id_whatsapp_business_account_id_idx" ON "whatsapp_accounts"("tenant_id", "whatsapp_business_account_id");

-- AddForeignKey
ALTER TABLE "whatsapp_business_accounts" ADD CONSTRAINT "whatsapp_business_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_tenant_id_whatsapp_business_account_id_fkey" FOREIGN KEY ("tenant_id", "whatsapp_business_account_id") REFERENCES "whatsapp_business_accounts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenant_id_whatsapp_business_account_id_fkey" FOREIGN KEY ("tenant_id", "whatsapp_business_account_id") REFERENCES "whatsapp_business_accounts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security for the new table (TAR-48's mechanism, hand-written
-- because Prisma's schema language cannot express it).
--
-- A tenant-scoped table without this is a silent isolation hole: it looks
-- finished in review and returns every tenant's rows at runtime. The predicate
-- is copied verbatim from 20260810140000_tenant_isolation_rls — see that file
-- for why `NULLIF(current_setting(..., true), '')` is the shape, and why FORCE
-- matters when migrations run as the owner.
--
-- This table is the reason the rule is worth restating: it now holds the
-- encrypted access token, which is the single most sensitive column in the
-- schema.
--
-- The second half — the `system_unrestricted` policy that lets SystemPrisma
-- across tenants, and the grants — is not here. Both are role-dependent and
-- live in prisma/sql/app-roles.sql, which derives its list from the catalog:
-- re-run `pnpm db:roles` after this migration.
-- ---------------------------------------------------------------------------

-- whatsapp_business_accounts
ALTER TABLE "public"."whatsapp_business_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."whatsapp_business_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."whatsapp_business_accounts"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
