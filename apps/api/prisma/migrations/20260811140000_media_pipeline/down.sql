-- Reverses 20260811140000_media_pipeline.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- What this costs, and when it is safe
-- ---------------------------------------------------------------------------
--
-- Safe and lossless on an empty `message_attachments` and an empty
-- `media_objects`, which is the state this migration was applied to.
--
-- **It destroys data on a populated one**, and no rollback can avoid that:
-- `media_objects` is where re-hosted inbound media is recorded, and Meta's own
-- copy expires five minutes after the message arrived. Dropping the table drops
-- the only index of what was downloaded. The *bytes* survive — they are in the
-- object store, under keys of the form `tenants/{tenant}/{kind}/{id}`, and
-- nothing here touches them — but nothing left in the database says which
-- message each one belonged to.
--
-- So: apply this only to roll back a deploy that has not yet processed inbound
-- media. Past that point the forward fix is a new migration, and the bytes in
-- the object store are the thing to reconcile against.
--
-- The `url` column is restored to NOT NULL. That is only possible while the
-- table holds no row with a NULL there, which is every row an inbound download
-- has not completed for. The DELETE below is what makes the constraint
-- restorable, and it is the destructive step named above.
--
-- Order matters: the foreign key from `message_attachments` to `media_objects`
-- goes before the table, and the columns typed on the enums go before the
-- enums.

SET LOCAL lock_timeout = '3s';

ALTER TABLE "public"."message_attachments"
    DROP CONSTRAINT IF EXISTS "message_attachments_tenant_id_media_object_id_fkey";

DROP INDEX IF EXISTS "public"."message_attachments_tenant_id_message_id_provider_media_id_key";
DROP INDEX IF EXISTS "public"."message_attachments_tenant_id_download_state_created_at_idx";

-- The destructive step. See the header: a row with no re-hosted URL cannot
-- satisfy the NOT NULL this restores, and there is nothing to put there.
DO $$
DECLARE
    discarded bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."message_attachments" NO FORCE ROW LEVEL SECURITY';

    DELETE FROM "public"."message_attachments" WHERE "url" IS NULL;
    GET DIAGNOSTICS discarded = ROW_COUNT;

    EXECUTE 'ALTER TABLE "public"."message_attachments" FORCE ROW LEVEL SECURITY';

    IF discarded > 0 THEN
        RAISE WARNING
            'Rollback discarded % message attachment(s) whose media had not been re-hosted. '
            'The messages remain; their attachments do not.', discarded;
    END IF;
END
$$;

ALTER TABLE "public"."message_attachments"
    DROP COLUMN IF EXISTS "media_object_id",
    DROP COLUMN IF EXISTS "download_error",
    DROP COLUMN IF EXISTS "download_state",
    DROP COLUMN IF EXISTS "kind",
    ALTER COLUMN "url" SET NOT NULL;

DROP TABLE IF EXISTS "public"."media_objects";

DROP TYPE IF EXISTS "media_download_state";
DROP TYPE IF EXISTS "media_source";
DROP TYPE IF EXISTS "media_kind";
