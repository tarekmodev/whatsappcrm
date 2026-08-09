-- Reverses 20260810130000_initial_data_model.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6). Generated
-- with `prisma migrate diff --from-schema prisma/schema.prisma
-- --to-migrations prisma/migrations --script` before the migration was created,
-- and reviewed. It is not applied automatically — see the "Rolling a migration
-- back" section of README.md.
--
-- ⚠️ THIS DESTROYS ALL APPLICATION DATA. It drops all 36 tables and all 22 enum
-- types created by the up migration. There is nothing incremental to preserve:
-- the up migration created the entire schema, so its reverse empties the
-- database. Only ever run it against a database whose contents are disposable,
-- or after a verified backup.
--
-- The baseline's `citext` and `pgcrypto` extensions are deliberately NOT
-- dropped here — they belong to 20260810120000_baseline_extensions and are
-- reversed by that migration's own down.sql.
--
-- Locks: ACCESS EXCLUSIVE on each dropped table, held only for its own
--   statement. Anything reading a table mid-drop fails, which is why this is
--   not an online operation.

-- DropForeignKey
ALTER TABLE "public"."tenant_domains" DROP CONSTRAINT "tenant_domains_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."tenant_branding" DROP CONSTRAINT "tenant_branding_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."tenant_settings" DROP CONSTRAINT "tenant_settings_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."users" DROP CONSTRAINT "users_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."sessions" DROP CONSTRAINT "sessions_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."sessions" DROP CONSTRAINT "sessions_tenant_id_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."invites" DROP CONSTRAINT "invites_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."invites" DROP CONSTRAINT "invites_tenant_id_invited_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."teams" DROP CONSTRAINT "teams_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."team_members" DROP CONSTRAINT "team_members_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."team_members" DROP CONSTRAINT "team_members_tenant_id_team_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."team_members" DROP CONSTRAINT "team_members_tenant_id_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."whatsapp_accounts" DROP CONSTRAINT "whatsapp_accounts_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."message_templates" DROP CONSTRAINT "message_templates_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."message_templates" DROP CONSTRAINT "message_templates_tenant_id_whatsapp_account_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."contacts" DROP CONSTRAINT "contacts_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."tags" DROP CONSTRAINT "tags_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."contact_tags" DROP CONSTRAINT "contact_tags_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."contact_tags" DROP CONSTRAINT "contact_tags_tenant_id_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."contact_tags" DROP CONSTRAINT "contact_tags_tenant_id_tag_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."custom_field_defs" DROP CONSTRAINT "custom_field_defs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."conversations" DROP CONSTRAINT "conversations_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."conversations" DROP CONSTRAINT "conversations_tenant_id_whatsapp_account_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."conversations" DROP CONSTRAINT "conversations_tenant_id_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."conversations" DROP CONSTRAINT "conversations_tenant_id_assigned_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."conversations" DROP CONSTRAINT "conversations_tenant_id_assigned_team_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."messages" DROP CONSTRAINT "messages_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."messages" DROP CONSTRAINT "messages_tenant_id_conversation_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."messages" DROP CONSTRAINT "messages_tenant_id_sender_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."message_attachments" DROP CONSTRAINT "message_attachments_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."message_attachments" DROP CONSTRAINT "message_attachments_tenant_id_message_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."internal_notes" DROP CONSTRAINT "internal_notes_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."internal_notes" DROP CONSTRAINT "internal_notes_tenant_id_conversation_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."internal_notes" DROP CONSTRAINT "internal_notes_tenant_id_author_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."tickets" DROP CONSTRAINT "tickets_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."tickets" DROP CONSTRAINT "tickets_tenant_id_conversation_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."tickets" DROP CONSTRAINT "tickets_tenant_id_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."tickets" DROP CONSTRAINT "tickets_tenant_id_assigned_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."tickets" DROP CONSTRAINT "tickets_tenant_id_assigned_team_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."ticket_events" DROP CONSTRAINT "ticket_events_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."ticket_events" DROP CONSTRAINT "ticket_events_tenant_id_ticket_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."ticket_events" DROP CONSTRAINT "ticket_events_tenant_id_actor_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."assignment_rules" DROP CONSTRAINT "assignment_rules_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."assignment_rules" DROP CONSTRAINT "assignment_rules_tenant_id_target_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."assignment_rules" DROP CONSTRAINT "assignment_rules_tenant_id_target_team_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."assignment_state" DROP CONSTRAINT "assignment_state_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."assignment_state" DROP CONSTRAINT "assignment_state_tenant_id_team_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."assignment_state" DROP CONSTRAINT "assignment_state_tenant_id_last_assigned_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."sla_policies" DROP CONSTRAINT "sla_policies_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."sla_timers" DROP CONSTRAINT "sla_timers_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."sla_timers" DROP CONSTRAINT "sla_timers_tenant_id_ticket_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."sla_timers" DROP CONSTRAINT "sla_timers_tenant_id_policy_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."workflows" DROP CONSTRAINT "workflows_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."workflow_runs" DROP CONSTRAINT "workflow_runs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."workflow_runs" DROP CONSTRAINT "workflow_runs_tenant_id_workflow_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."ai_configs" DROP CONSTRAINT "ai_configs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."knowledge_documents" DROP CONSTRAINT "knowledge_documents_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."canned_responses" DROP CONSTRAINT "canned_responses_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."canned_responses" DROP CONSTRAINT "canned_responses_tenant_id_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."subscriptions" DROP CONSTRAINT "subscriptions_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."subscriptions" DROP CONSTRAINT "subscriptions_plan_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."usage_counters" DROP CONSTRAINT "usage_counters_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."webhook_events" DROP CONSTRAINT "webhook_events_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."idempotency_keys" DROP CONSTRAINT "idempotency_keys_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."audit_logs" DROP CONSTRAINT "audit_logs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."audit_logs" DROP CONSTRAINT "audit_logs_tenant_id_actor_user_id_fkey";

-- DropTable
DROP TABLE "public"."tenants";

-- DropTable
DROP TABLE "public"."tenant_domains";

-- DropTable
DROP TABLE "public"."tenant_branding";

-- DropTable
DROP TABLE "public"."tenant_settings";

-- DropTable
DROP TABLE "public"."users";

-- DropTable
DROP TABLE "public"."sessions";

-- DropTable
DROP TABLE "public"."invites";

-- DropTable
DROP TABLE "public"."teams";

-- DropTable
DROP TABLE "public"."team_members";

-- DropTable
DROP TABLE "public"."whatsapp_accounts";

-- DropTable
DROP TABLE "public"."message_templates";

-- DropTable
DROP TABLE "public"."contacts";

-- DropTable
DROP TABLE "public"."tags";

-- DropTable
DROP TABLE "public"."contact_tags";

-- DropTable
DROP TABLE "public"."custom_field_defs";

-- DropTable
DROP TABLE "public"."conversations";

-- DropTable
DROP TABLE "public"."messages";

-- DropTable
DROP TABLE "public"."message_attachments";

-- DropTable
DROP TABLE "public"."internal_notes";

-- DropTable
DROP TABLE "public"."tickets";

-- DropTable
DROP TABLE "public"."ticket_events";

-- DropTable
DROP TABLE "public"."assignment_rules";

-- DropTable
DROP TABLE "public"."assignment_state";

-- DropTable
DROP TABLE "public"."sla_policies";

-- DropTable
DROP TABLE "public"."sla_timers";

-- DropTable
DROP TABLE "public"."workflows";

-- DropTable
DROP TABLE "public"."workflow_runs";

-- DropTable
DROP TABLE "public"."ai_configs";

-- DropTable
DROP TABLE "public"."knowledge_documents";

-- DropTable
DROP TABLE "public"."canned_responses";

-- DropTable
DROP TABLE "public"."plans";

-- DropTable
DROP TABLE "public"."subscriptions";

-- DropTable
DROP TABLE "public"."usage_counters";

-- DropTable
DROP TABLE "public"."webhook_events";

-- DropTable
DROP TABLE "public"."idempotency_keys";

-- DropTable
DROP TABLE "public"."audit_logs";

-- DropEnum
DROP TYPE "public"."tenant_status";

-- DropEnum
DROP TYPE "public"."tenant_domain_kind";

-- DropEnum
DROP TYPE "public"."user_role";

-- DropEnum
DROP TYPE "public"."user_status";

-- DropEnum
DROP TYPE "public"."user_availability";

-- DropEnum
DROP TYPE "public"."whatsapp_account_status";

-- DropEnum
DROP TYPE "public"."message_template_status";

-- DropEnum
DROP TYPE "public"."custom_field_type";

-- DropEnum
DROP TYPE "public"."conversation_status";

-- DropEnum
DROP TYPE "public"."message_direction";

-- DropEnum
DROP TYPE "public"."message_status";

-- DropEnum
DROP TYPE "public"."message_content_type";

-- DropEnum
DROP TYPE "public"."ticket_status";

-- DropEnum
DROP TYPE "public"."ticket_priority";

-- DropEnum
DROP TYPE "public"."sla_target_kind";

-- DropEnum
DROP TYPE "public"."sla_timer_state";

-- DropEnum
DROP TYPE "public"."workflow_run_status";

-- DropEnum
DROP TYPE "public"."knowledge_document_status";

-- DropEnum
DROP TYPE "public"."billing_interval";

-- DropEnum
DROP TYPE "public"."subscription_status";

-- DropEnum
DROP TYPE "public"."webhook_event_status";

-- DropEnum
DROP TYPE "public"."idempotency_key_state";
