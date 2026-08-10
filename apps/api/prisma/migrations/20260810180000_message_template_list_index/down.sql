-- Reverses 20260810180000_message_template_list_index.
--
-- Drops the index and nothing else. No column, constraint or row was added, so
-- there is nothing to restore and no data to lose: the only consequence is that
-- `GET /api/v1/message-templates` goes back to a sequential scan.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit.

BEGIN;

DROP INDEX IF EXISTS "public"."message_templates_tenant_id_status_created_at_id_idx";

COMMIT;
