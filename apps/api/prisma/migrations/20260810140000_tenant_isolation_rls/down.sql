-- Reverses 20260810140000_tenant_isolation_rls.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6). Nothing to
-- generate here in any case — `prisma migrate diff` does not see policies at
-- all. It is not applied automatically; see the "Rolling a migration back"
-- section of README.md for how to run it and how to correct Prisma's history
-- afterwards.
--
-- ⚠️ THIS REMOVES TENANT ISOLATION. No data is lost and no table changes shape,
-- but after this runs, every connection sees every tenant's rows and the only
-- thing standing between two customers' data is application code remembering a
-- `where` clause. That is precisely the state TAR-18's isolation requirement
-- rules out. Run it to unblock a rollback of the schema underneath, then put it
-- back — not as a way to work around a policy that is getting in the way.
--
-- Order matters: `DROP POLICY` before `DISABLE ROW LEVEL SECURITY`. The reverse
-- order leaves an enabled table with no policy, which denies everything to
-- every non-superuser for as long as the window lasts.
--
-- `system_unrestricted` is dropped alongside it. That policy is created by
-- `prisma/sql/app-roles.sql` rather than by the up migration, so it may not
-- exist — hence `IF EXISTS`. Leaving it behind would be harmless while RLS is
-- off but would silently survive a later re-apply of the up migration, which is
-- worse than removing it and re-running the bootstrap script.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit — without it a
-- failure halfway through would leave some tables protected and some not, and
-- `SET LOCAL lock_timeout` would be a no-op warning rather than a limit.
--
-- Locks: ACCESS EXCLUSIVE on each of the 33 tables, catalog-only, held for the
--   length of the transaction. Milliseconds. No table is rewritten.
-- Data loss: none.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- tenant_domains
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."tenant_domains";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."tenant_domains";
ALTER TABLE "public"."tenant_domains" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_domains" DISABLE ROW LEVEL SECURITY;

-- tenant_branding
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."tenant_branding";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."tenant_branding";
ALTER TABLE "public"."tenant_branding" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_branding" DISABLE ROW LEVEL SECURITY;

-- tenant_settings
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."tenant_settings";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."tenant_settings";
ALTER TABLE "public"."tenant_settings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_settings" DISABLE ROW LEVEL SECURITY;

-- users
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."users";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."users";
ALTER TABLE "public"."users" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."users" DISABLE ROW LEVEL SECURITY;

-- sessions
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."sessions";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."sessions";
ALTER TABLE "public"."sessions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."sessions" DISABLE ROW LEVEL SECURITY;

-- invites
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."invites";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."invites";
ALTER TABLE "public"."invites" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."invites" DISABLE ROW LEVEL SECURITY;

-- teams
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."teams";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."teams";
ALTER TABLE "public"."teams" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."teams" DISABLE ROW LEVEL SECURITY;

-- team_members
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."team_members";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."team_members";
ALTER TABLE "public"."team_members" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."team_members" DISABLE ROW LEVEL SECURITY;

-- whatsapp_accounts
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."whatsapp_accounts";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."whatsapp_accounts";
ALTER TABLE "public"."whatsapp_accounts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."whatsapp_accounts" DISABLE ROW LEVEL SECURITY;

-- message_templates
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."message_templates";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."message_templates";
ALTER TABLE "public"."message_templates" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."message_templates" DISABLE ROW LEVEL SECURITY;

-- contacts
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."contacts";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."contacts";
ALTER TABLE "public"."contacts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."contacts" DISABLE ROW LEVEL SECURITY;

-- tags
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."tags";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."tags";
ALTER TABLE "public"."tags" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."tags" DISABLE ROW LEVEL SECURITY;

-- contact_tags
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."contact_tags";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."contact_tags";
ALTER TABLE "public"."contact_tags" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."contact_tags" DISABLE ROW LEVEL SECURITY;

-- custom_field_defs
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."custom_field_defs";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."custom_field_defs";
ALTER TABLE "public"."custom_field_defs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."custom_field_defs" DISABLE ROW LEVEL SECURITY;

-- conversations
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."conversations";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."conversations";
ALTER TABLE "public"."conversations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."conversations" DISABLE ROW LEVEL SECURITY;

-- messages
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."messages";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."messages";
ALTER TABLE "public"."messages" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."messages" DISABLE ROW LEVEL SECURITY;

-- message_attachments
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."message_attachments";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."message_attachments";
ALTER TABLE "public"."message_attachments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."message_attachments" DISABLE ROW LEVEL SECURITY;

-- internal_notes
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."internal_notes";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."internal_notes";
ALTER TABLE "public"."internal_notes" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."internal_notes" DISABLE ROW LEVEL SECURITY;

-- tickets
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."tickets";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."tickets";
ALTER TABLE "public"."tickets" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."tickets" DISABLE ROW LEVEL SECURITY;

-- ticket_events
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."ticket_events";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."ticket_events";
ALTER TABLE "public"."ticket_events" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."ticket_events" DISABLE ROW LEVEL SECURITY;

-- assignment_rules
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."assignment_rules";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."assignment_rules";
ALTER TABLE "public"."assignment_rules" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."assignment_rules" DISABLE ROW LEVEL SECURITY;

-- assignment_state
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."assignment_state";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."assignment_state";
ALTER TABLE "public"."assignment_state" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."assignment_state" DISABLE ROW LEVEL SECURITY;

-- sla_policies
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."sla_policies";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."sla_policies";
ALTER TABLE "public"."sla_policies" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."sla_policies" DISABLE ROW LEVEL SECURITY;

-- sla_timers
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."sla_timers";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."sla_timers";
ALTER TABLE "public"."sla_timers" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."sla_timers" DISABLE ROW LEVEL SECURITY;

-- workflows
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."workflows";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."workflows";
ALTER TABLE "public"."workflows" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."workflows" DISABLE ROW LEVEL SECURITY;

-- workflow_runs
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."workflow_runs";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."workflow_runs";
ALTER TABLE "public"."workflow_runs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."workflow_runs" DISABLE ROW LEVEL SECURITY;

-- ai_configs
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."ai_configs";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."ai_configs";
ALTER TABLE "public"."ai_configs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."ai_configs" DISABLE ROW LEVEL SECURITY;

-- knowledge_documents
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."knowledge_documents";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."knowledge_documents";
ALTER TABLE "public"."knowledge_documents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."knowledge_documents" DISABLE ROW LEVEL SECURITY;

-- canned_responses
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."canned_responses";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."canned_responses";
ALTER TABLE "public"."canned_responses" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."canned_responses" DISABLE ROW LEVEL SECURITY;

-- subscriptions
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."subscriptions";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."subscriptions";
ALTER TABLE "public"."subscriptions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."subscriptions" DISABLE ROW LEVEL SECURITY;

-- usage_counters
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."usage_counters";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."usage_counters";
ALTER TABLE "public"."usage_counters" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."usage_counters" DISABLE ROW LEVEL SECURITY;

-- idempotency_keys
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."idempotency_keys";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."idempotency_keys";
ALTER TABLE "public"."idempotency_keys" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."idempotency_keys" DISABLE ROW LEVEL SECURITY;

-- audit_logs
DROP POLICY IF EXISTS "system_unrestricted" ON "public"."audit_logs";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."audit_logs";
ALTER TABLE "public"."audit_logs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."audit_logs" DISABLE ROW LEVEL SECURITY;

COMMIT;
