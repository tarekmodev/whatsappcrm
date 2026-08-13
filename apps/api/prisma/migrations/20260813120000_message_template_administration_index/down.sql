-- Reverses 20260813120000_message_template_administration_index.
--
-- Drops the index and nothing else. No column, constraint or row was added, so
-- there is nothing to restore and no data to lose: the only consequence is that
-- `GET /api/v1/whatsapp/message-templates` reads the composer's index and sorts,
-- which is correct and slower. The composer's own list is untouched either way.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit.

BEGIN;

DROP INDEX IF EXISTS "public"."message_templates_tenant_id_name_language_id_idx";

COMMIT;
