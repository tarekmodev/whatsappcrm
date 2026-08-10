-- Tenant isolation at the data layer (TAR-48).
--
-- Turns on row-level security for all 33 tenant-scoped tables and attaches one
-- policy, `tenant_isolation`, to each. From here a query that forgets its
-- `tenant_id` filter returns nothing rather than another tenant's rows.
--
-- Hand-written, not generated: Prisma's schema language cannot express RLS, so
-- `prisma migrate diff` produces nothing for this change and will never propose
-- to drop it either (Prisma ignores policies entirely, so this is not drift).
--
-- ---------------------------------------------------------------------------
-- The predicate, and why it is shaped this way
-- ---------------------------------------------------------------------------
--
--   tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
--
-- `current_setting(..., true)` is the missing_ok form: it returns NULL instead
-- of raising when the GUC has never been set on the connection. `NULLIF(…, '')`
-- covers the second, less obvious case — a GUC that *was* set and has since
-- been reset (which is what a transaction-local `set_config(…, true)` leaves
-- behind at commit) reads back as the empty string, not NULL. Without the
-- NULLIF that empty string reaches `::uuid` and the query fails with a cast
-- error instead of returning zero rows. Both paths must mean "no tenant".
--
-- Either way the comparison yields NULL, which is not `true`, so the row is
-- filtered out: **no GUC means zero rows, never unscoped access.** The
-- dangerous inverse is impossible by construction — there is no value of the
-- setting that matches more than one tenant.
--
-- `current_setting` is STABLE, so it is evaluated once per query and the
-- planner can push the result into an index qualifier. Every tenant-scoped
-- index leads with `tenant_id` (TAR-39, decision 1, rule 3), so the policy
-- predicate uses the same access path the application filter already uses.
--
-- ---------------------------------------------------------------------------
-- FORCE, and the role that is not in this file
-- ---------------------------------------------------------------------------
--
-- `ENABLE` alone exempts the table owner, and migrations run as the owner — so
-- the owner is exactly the role whose queries must not be exempt. `FORCE` closes
-- that. What it cannot close is `SUPERUSER` and `BYPASSRLS`, which skip policy
-- evaluation entirely; that is a role attribute, not a table property.
--
-- So this migration is only half the mechanism. The other half is the
-- application role, which must hold neither attribute — `prisma/sql/app-roles.sql`,
-- run once per environment. Deliberately not part of this migration: roles are
-- cluster-scoped rather than database-scoped, they need a password from the
-- environment's secret store, and `CREATE ROLE` needs a privilege the deploy
-- user on a managed Postgres may not have. A migration that cannot run
-- everywhere is worse than a documented bootstrap step.
--
-- The policy below is therefore role-agnostic (`TO PUBLIC`) and references no
-- role name, so this migration applies to a cluster where those roles do not
-- exist yet.
--
-- ---------------------------------------------------------------------------
-- The three tables deliberately left out
-- ---------------------------------------------------------------------------
--
--   tenants          It *is* the tenant. Scoping it by `id` would break the two
--                    reads that happen before a tenant is known — provisioning
--                    and host→tenant resolution. TAR-39, data model.
--   plans            Platform-wide product catalogue, the same rows for every
--                    tenant. Public product data, not tenant data.
--   webhook_events   Written before the tenant is known, so `tenant_id` is
--                    nullable and a policy on it would reject every ingest.
--                    TAR-39 names this as the deliberate exception; it is
--                    reached only through `SystemPrisma`, and the app role is
--                    granted nothing on it (`prisma/sql/app-roles.sql`).
--
-- Every other table in `public` carries a non-null `tenant_id` and appears
-- below. `prisma/sql/verify-tenant-isolation.sql` fails if that stops being
-- true — it derives the list from the catalog rather than trusting this file,
-- so a table added later without a policy is caught rather than assumed.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Catalog updates only — no table is rewritten,
--                no index is built, no row is read.
--   Locks        ACCESS EXCLUSIVE on each of the 33 tables. Prisma wraps a
--                migration in one transaction, so every lock is held until the
--                last statement commits. On a live database that is a brief
--                stop-the-world across the whole schema.
--   Blocking     The `lock_timeout` below caps the wait at three seconds. A
--                long-running transaction holding a conflicting lock therefore
--                aborts this migration cleanly instead of queueing behind it
--                and blocking every new query in the meantime. Re-run it after
--                the blocker clears.
--   Rollback     `down.sql` beside this file. Reversible with no data loss.
--
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '3s';

-- tenant_domains
ALTER TABLE "public"."tenant_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_domains" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."tenant_domains"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- tenant_branding
ALTER TABLE "public"."tenant_branding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_branding" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."tenant_branding"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- tenant_settings
ALTER TABLE "public"."tenant_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."tenant_settings"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- users
ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."users"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- sessions
ALTER TABLE "public"."sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."sessions"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- invites
ALTER TABLE "public"."invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."invites" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."invites"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- teams
ALTER TABLE "public"."teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."teams" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."teams"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- team_members
ALTER TABLE "public"."team_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."team_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."team_members"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- whatsapp_accounts
ALTER TABLE "public"."whatsapp_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."whatsapp_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."whatsapp_accounts"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- message_templates
ALTER TABLE "public"."message_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."message_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."message_templates"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- contacts
ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."contacts"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- tags
ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."tags"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- contact_tags
ALTER TABLE "public"."contact_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."contact_tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."contact_tags"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- custom_field_defs
ALTER TABLE "public"."custom_field_defs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."custom_field_defs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."custom_field_defs"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- conversations
ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."conversations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."conversations"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- messages
ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."messages"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- message_attachments
ALTER TABLE "public"."message_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."message_attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."message_attachments"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- internal_notes
ALTER TABLE "public"."internal_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."internal_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."internal_notes"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- tickets
ALTER TABLE "public"."tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."tickets"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ticket_events
ALTER TABLE "public"."ticket_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ticket_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."ticket_events"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- assignment_rules
ALTER TABLE "public"."assignment_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."assignment_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."assignment_rules"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- assignment_state
ALTER TABLE "public"."assignment_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."assignment_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."assignment_state"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- sla_policies
ALTER TABLE "public"."sla_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sla_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."sla_policies"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- sla_timers
ALTER TABLE "public"."sla_timers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sla_timers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."sla_timers"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- workflows
ALTER TABLE "public"."workflows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."workflows" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."workflows"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- workflow_runs
ALTER TABLE "public"."workflow_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."workflow_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."workflow_runs"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ai_configs
ALTER TABLE "public"."ai_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ai_configs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."ai_configs"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- knowledge_documents
ALTER TABLE "public"."knowledge_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."knowledge_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."knowledge_documents"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- canned_responses
ALTER TABLE "public"."canned_responses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."canned_responses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."canned_responses"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- subscriptions
ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."subscriptions"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- usage_counters
ALTER TABLE "public"."usage_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."usage_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."usage_counters"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- idempotency_keys
ALTER TABLE "public"."idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."idempotency_keys"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- audit_logs
ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."audit_logs"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
