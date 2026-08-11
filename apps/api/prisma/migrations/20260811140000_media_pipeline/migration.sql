-- The media pipeline: stored binaries, and what an attachment says about one (TAR-20e).
--
-- Adds `media_objects` — one row per stored binary — and grows
-- `message_attachments` into the join between a message and one.
--
-- ---------------------------------------------------------------------------
-- Why a second table, when 0002 fixes `message_attachments`
-- ---------------------------------------------------------------------------
--
-- Because `POST /api/v1/media` returns a `mediaId` **before** any message
-- exists. 0002's endpoint list has said so since TAR-39 — the composer uploads,
-- gets an id, and names it in the send that follows — and an attachment row
-- cannot represent that state: `message_id` is what makes a row an attachment,
-- and it is NOT NULL and half of the composite foreign key to `messages`.
--
-- The alternatives were considered and are worse:
--
--   * Make `message_id` nullable. It widens the column, so it is additive — but
--     it makes "an attachment attached to nothing" a legal state that every
--     later reader of the table has to handle, and it leaves an upload that was
--     never sent sitting in the message-attachment table forever.
--   * Return the *storage key* as the `mediaId`. The id would then be a path
--     supplied by the client on the next request, which is a path-traversal and
--     cross-tenant read waiting to happen. Ids are opaque row ids, always.
--
-- So: a binary is an entity, an attachment is a relationship. 0002's entity
-- table gains a row rather than changing one; `docs/reference/data-model.md`
-- records the addition.
--
-- ---------------------------------------------------------------------------
-- Additive, and idempotent in the sense the fleet runner needs
-- ---------------------------------------------------------------------------
--
-- Nothing is dropped, renamed or retyped. Two columns of the existing table
-- gain values, one loses a NOT NULL (a widening — every value that was legal
-- before is still legal), and everything else is new.
--
-- Prisma runs a migration in one transaction and records it in
-- `_prisma_migrations`, so a re-run is a no-op at the runner level rather than
-- at the statement level, and a run that fails part way rolls back whole. The
-- guard below is the one thing that has to be checked before the statements,
-- not by them.
--
-- ---------------------------------------------------------------------------
-- `message_attachments.kind` is NOT NULL with no default, deliberately
-- ---------------------------------------------------------------------------
--
-- The table is empty in every environment: TAR-20's ingestion pipeline landed
-- without an attachment write path, and this migration is what adds one. A
-- default would have to be a guess — `document` for a photograph — and the row
-- it mislabelled would be indistinguishable from a correct one forever.
--
-- The DO block asserts the emptiness rather than assuming it, so an environment
-- that somehow has rows gets a sentence explaining what to do instead of
-- Postgres's "column contains null values". If that ever fires, the fix is a
-- separate backfill migration that derives `kind` from `mime_type`, shipped
-- before this one.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. `media_objects` is created empty;
--                `message_attachments` is empty, so its ALTER, its index builds
--                and the NOT NULL scan all touch zero rows. Expected runtime on
--                the largest tenant: unchanged — this is a single shared
--                database, and size does not enter into a catalogue update over
--                an empty table.
--   Locks        ACCESS EXCLUSIVE on `message_attachments`, held to commit. The
--                indexes are built non-concurrently, which is correct here only
--                because the table is empty; on a populated table they would be
--                `CREATE INDEX CONCURRENTLY` outside a transaction.
--   Blocking     `lock_timeout` caps the wait at three seconds, so a conflicting
--                long-running transaction aborts this migration cleanly rather
--                than queueing ahead of every new query. Re-run once it clears.
--   Data loss    None. Nothing is dropped and no existing value is overwritten.
--   Rollback     `down.sql` beside this file. Reversible with no data loss on an
--                empty table; see its header for what it costs on a full one.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Precondition, before the statement that depends on it.
-- ---------------------------------------------------------------------------
--
-- The FORCE ROW LEVEL SECURITY toggle is the same manoeuvre TAR-52 and TAR-92
-- use: the migration owner is not exempt from FORCE, and no `app.tenant_id` GUC
-- is set here, so `tenant_isolation` matches nothing and a plain count would
-- report 0 on a table full of rows — turning this guard into a rubber stamp.
--
-- Safe inline: DDL is transactional in Postgres, the ALTER below takes ACCESS
-- EXCLUSIVE on the same table moments later, and an abort rolls the toggle back
-- with everything else.
DO $$
DECLARE
    existing bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."message_attachments" NO FORCE ROW LEVEL SECURITY';

    SELECT count(*) INTO existing FROM "public"."message_attachments";

    EXECUTE 'ALTER TABLE "public"."message_attachments" FORCE ROW LEVEL SECURITY';

    IF existing > 0 THEN
        RAISE EXCEPTION
            'message_attachments holds % row(s), and TAR-20e adds a NOT NULL "kind" column '
            'with no default. Ship a backfill migration that derives kind from mime_type '
            'before this one.', existing;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Schema change. Generated by `prisma migrate diff`, read before committing.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "media_kind" AS ENUM ('image', 'video', 'audio', 'document', 'sticker');

-- CreateEnum
CREATE TYPE "media_source" AS ENUM ('inbound', 'upload');

-- CreateEnum
CREATE TYPE "media_download_state" AS ENUM ('pending', 'stored', 'failed');

-- AlterTable
ALTER TABLE "message_attachments" ADD COLUMN     "download_error" TEXT,
ADD COLUMN     "download_state" "media_download_state" NOT NULL DEFAULT 'stored',
ADD COLUMN     "kind" "media_kind" NOT NULL,
ADD COLUMN     "media_object_id" UUID,
ALTER COLUMN "url" DROP NOT NULL;

-- CreateTable
CREATE TABLE "media_objects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "media_kind" NOT NULL,
    "source" "media_source" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "file_name" TEXT,
    "provider_media_id" TEXT,
    "uploaded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_objects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_objects_tenant_id_created_at_id_idx" ON "media_objects"("tenant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "media_objects_tenant_id_uploaded_by_user_id_idx" ON "media_objects"("tenant_id", "uploaded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_objects_tenant_id_id_key" ON "media_objects"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "media_objects_tenant_id_storage_key_key" ON "media_objects"("tenant_id", "storage_key");

-- CreateIndex
CREATE INDEX "message_attachments_tenant_id_download_state_created_at_idx" ON "message_attachments"("tenant_id", "download_state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_tenant_id_message_id_provider_media_id_key" ON "message_attachments"("tenant_id", "message_id", "provider_media_id");

-- AddForeignKey
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_tenant_id_uploaded_by_user_id_fkey" FOREIGN KEY ("tenant_id", "uploaded_by_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_tenant_id_media_object_id_fkey" FOREIGN KEY ("tenant_id", "media_object_id") REFERENCES "media_objects"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Row-level security for the new table. Hand-written: Prisma's schema language
-- cannot express a policy, so `migrate diff` produces nothing for this and will
-- never propose to drop it either.
--
-- Same predicate as every other scoped table
-- (20260810140000_tenant_isolation_rls), and the same reason for FORCE: ENABLE
-- alone exempts the table owner, and migrations run as the owner.
--
-- `system_unrestricted` — SystemPrisma's second policy — and the table grants
-- are not here. Both are role-dependent, and roles are cluster-scoped:
-- `prisma/sql/app-roles.sql` derives them from the catalogue and is documented
-- to be re-run after any migration that adds a table.
-- `prisma/sql/verify-tenant-isolation.sql` fails by name until it has been.
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."media_objects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."media_objects" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."media_objects"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
