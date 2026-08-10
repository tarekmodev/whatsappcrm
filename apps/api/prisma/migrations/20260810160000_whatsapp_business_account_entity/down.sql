-- Reverses 20260810160000_whatsapp_business_account_entity.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6). Generated
-- with `prisma migrate diff --from-schema prisma/schema.prisma
-- --to-migrations prisma/migrations --script` before the migration was created,
-- then reviewed and extended by hand — the generated script restores the
-- columns but knows nothing about row-level security, so the symmetry with the
-- up migration's RLS block is added below rather than assumed.
--
-- ---------------------------------------------------------------------------
-- What this destroys
-- ---------------------------------------------------------------------------
--
-- ⚠️ `DROP TABLE whatsapp_business_accounts` takes every WABA row with it,
-- **including access_token_encrypted**. The up migration's guard means this can
-- only have been applied to empty tables, so at the version this reverses there
-- is nothing to lose — and that is the only circumstance in which running this
-- is safe. Once TAR-20 has connected a real WABA, rolling back means restoring
-- from a verified backup or re-running Embedded Signup to reissue the token,
-- not running this file.
--
-- The restored `whatsapp_accounts.waba_id` and `message_templates.
-- whatsapp_account_id` come back NOT NULL with no default, which is possible
-- only because both tables are empty. On a non-empty table these statements
-- fail — loudly, before anything is dropped, which is the right failure.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds; every affected table is empty.
--   Locks        ACCESS EXCLUSIVE on whatsapp_accounts, message_templates and
--                whatsapp_business_accounts, each for its own statement.
--   Blocking     Not an online operation — a reader mid-drop fails.
--   Roles        The `system_unrestricted` policy and the grants on
--                whatsapp_business_accounts belong to prisma/sql/app-roles.sql,
--                not to this migration. `DROP TABLE` removes both along with the
--                table, so there is nothing to undo there; re-running
--                `pnpm db:roles` afterwards is harmless and re-asserts the rest.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit — without it a
-- failure halfway through would leave the tables half-reverted, and
-- `SET LOCAL lock_timeout` would be a no-op warning rather than a limit.
--
-- Not applied automatically — see the "Rolling a migration back" section of
-- README.md, including the `_prisma_migrations` row that has to be deleted
-- afterwards.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- DropForeignKey
ALTER TABLE "public"."whatsapp_business_accounts" DROP CONSTRAINT "whatsapp_business_accounts_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."whatsapp_accounts" DROP CONSTRAINT "whatsapp_accounts_tenant_id_whatsapp_business_account_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."message_templates" DROP CONSTRAINT "message_templates_tenant_id_whatsapp_business_account_id_fkey";

-- DropIndex
DROP INDEX "public"."whatsapp_accounts_tenant_id_whatsapp_business_account_id_idx";

-- DropIndex
DROP INDEX "public"."message_templates_tenant_id_whatsapp_business_account_id_na_key";

-- AlterTable
ALTER TABLE "public"."whatsapp_accounts" DROP COLUMN "quality_rating",
DROP COLUMN "whatsapp_business_account_id",
ADD COLUMN     "access_token_encrypted" TEXT,
ADD COLUMN     "waba_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "public"."message_templates" DROP COLUMN "whatsapp_business_account_id",
ADD COLUMN     "whatsapp_account_id" UUID NOT NULL;

-- DropTable
-- Drops the table's `tenant_isolation` policy and its `system_unrestricted`
-- policy with it; policies are owned by the relation, so neither needs its own
-- statement here.
DROP TABLE "public"."whatsapp_business_accounts";

-- DropEnum
DROP TYPE "public"."whatsapp_business_verification_status";

-- DropEnum
DROP TYPE "public"."whatsapp_quality_rating";

-- CreateIndex
CREATE INDEX "whatsapp_accounts_tenant_id_idx" ON "public"."whatsapp_accounts"("tenant_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_tenant_id_name_language_key" ON "public"."message_templates"("tenant_id" ASC, "name" ASC, "language" ASC);

-- CreateIndex
CREATE INDEX "message_templates_tenant_id_whatsapp_account_id_idx" ON "public"."message_templates"("tenant_id" ASC, "whatsapp_account_id" ASC);

-- AddForeignKey
ALTER TABLE "public"."message_templates" ADD CONSTRAINT "message_templates_tenant_id_whatsapp_account_id_fkey" FOREIGN KEY ("tenant_id", "whatsapp_account_id") REFERENCES "public"."whatsapp_accounts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
