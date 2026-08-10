-- Initial data model (TAR-47).
--
-- Creates every entity in the data-model table of
-- docs/architecture/0002-architecture-and-api-contract.md (TAR-39): 36 tables,
-- 22 enum types, and the indexes that document names as load-bearing. The
-- reasoning behind each constraint lives next to the model in schema.prisma;
-- this file is Prisma's output from that schema, read before committing.
--
-- Directory name: this migration must sort AFTER 20260810120000_baseline_
-- extensions, which creates `citext`. `migrate dev` stamps a migration with the
-- current UTC time, which landed before the baseline's hand-picked timestamp,
-- so the directory was renamed. Migrations apply in lexicographic order — with
-- the generated name, a fresh database would have failed on the first CITEXT
-- column.
--
-- Ordering within the file is Prisma's own and matters: enums, then tables,
-- then indexes, then foreign keys. The composite `(tenant_id, id)` unique
-- indexes have to exist before the composite foreign keys that reference them.
--
-- Estimated duration: under a second. Every table is created empty.
-- Locks: ACCESS EXCLUSIVE on each new table, which nothing else can be holding
--   — they do not exist until this statement runs. No existing object is
--   altered, so nothing is blocked.
-- Blocking risk: none. This is safe to run against a live database.
-- Rollback: `down.sql` in this directory. It drops every object created here
--   and therefore DESTROYS ALL DATA in them. See the "Rolling a migration
--   back" section of README.md for how to apply it and how to correct Prisma's
--   history afterwards.

-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('pending', 'active', 'suspended', 'cancelled');

-- CreateEnum
CREATE TYPE "tenant_domain_kind" AS ENUM ('platform', 'custom');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('owner', 'admin', 'supervisor', 'agent');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('invited', 'active', 'suspended', 'removed');

-- CreateEnum
CREATE TYPE "user_availability" AS ENUM ('available', 'away', 'offline');

-- CreateEnum
CREATE TYPE "whatsapp_account_status" AS ENUM ('connected', 'disconnected', 'error');

-- CreateEnum
CREATE TYPE "message_template_status" AS ENUM ('pending', 'approved', 'rejected', 'paused', 'disabled');

-- CreateEnum
CREATE TYPE "custom_field_type" AS ENUM ('text', 'number', 'date', 'boolean', 'select', 'multi_select');

-- CreateEnum
CREATE TYPE "conversation_status" AS ENUM ('open', 'pending', 'resolved');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('received', 'queued', 'sent', 'delivered', 'read', 'failed');

-- CreateEnum
CREATE TYPE "message_content_type" AS ENUM ('text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts', 'interactive', 'template', 'system');

-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('open', 'pending', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "ticket_priority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "sla_target_kind" AS ENUM ('first_response', 'resolution');

-- CreateEnum
CREATE TYPE "sla_timer_state" AS ENUM ('running', 'met', 'breached', 'cancelled');

-- CreateEnum
CREATE TYPE "workflow_run_status" AS ENUM ('pending', 'running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "knowledge_document_status" AS ENUM ('pending', 'indexed', 'failed');

-- CreateEnum
CREATE TYPE "billing_interval" AS ENUM ('month', 'year');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'incomplete');

-- CreateEnum
CREATE TYPE "webhook_event_status" AS ENUM ('received', 'processing', 'processed', 'failed');

-- CreateEnum
CREATE TYPE "idempotency_key_state" AS ENUM ('in_progress', 'completed');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'pending',
    "trial_ends_at" TIMESTAMPTZ(3),
    "suspended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_domains" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "hostname" CITEXT NOT NULL,
    "kind" "tenant_domain_kind" NOT NULL DEFAULT 'platform',
    "verified_at" TIMESTAMPTZ(3),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_branding" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_name" TEXT,
    "logo_url" TEXT,
    "favicon_url" TEXT,
    "primary_color" TEXT,
    "accent_color" TEXT,
    "support_email" CITEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_branding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "business_hours" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "password_hash" TEXT,
    "name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "role" "user_role" NOT NULL DEFAULT 'agent',
    "status" "user_status" NOT NULL DEFAULT 'invited',
    "availability" "user_availability" NOT NULL DEFAULT 'offline',
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'agent',
    "token_hash" TEXT NOT NULL,
    "invited_by_user_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "display_phone_number" TEXT NOT NULL,
    "verified_name" TEXT,
    "access_token_encrypted" TEXT,
    "status" "whatsapp_account_status" NOT NULL DEFAULT 'disconnected',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "whatsapp_account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT,
    "status" "message_template_status" NOT NULL DEFAULT 'pending',
    "components" JSONB,
    "provider_template_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "display_name" TEXT,
    "email" CITEXT,
    "locale" TEXT,
    "custom_fields" JSONB,
    "opted_out_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_tags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_defs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "custom_field_type" NOT NULL DEFAULT 'text',
    "options" JSONB,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "custom_field_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "whatsapp_account_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "conversation_status" NOT NULL DEFAULT 'open',
    "assigned_user_id" UUID,
    "assigned_team_id" UUID,
    "service_window_expires_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "direction" "message_direction" NOT NULL,
    "status" "message_status" NOT NULL,
    "content_type" "message_content_type" NOT NULL DEFAULT 'text',
    "body" TEXT,
    "provider_message_id" TEXT,
    "sender_user_id" UUID,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "delivered_at" TIMESTAMPTZ(3),
    "read_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER,
    "filename" TEXT,
    "provider_media_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "author_user_id" UUID,
    "body" TEXT NOT NULL,
    "mentioned_user_ids" UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "internal_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "subject" TEXT,
    "status" "ticket_status" NOT NULL DEFAULT 'open',
    "priority" "ticket_priority" NOT NULL DEFAULT 'normal',
    "conversation_id" UUID,
    "contact_id" UUID,
    "assigned_user_id" UUID,
    "assigned_team_id" UUID,
    "first_response_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "target_user_id" UUID,
    "target_team_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assignment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_state" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "last_assigned_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assignment_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priority" "ticket_priority",
    "first_response_minutes" INTEGER,
    "resolution_minutes" INTEGER,
    "business_hours_only" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_timers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "kind" "sla_target_kind" NOT NULL,
    "state" "sla_timer_state" NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "stopped_at" TIMESTAMPTZ(3),

    CONSTRAINT "sla_timers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "definition" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "status" "workflow_run_status" NOT NULL DEFAULT 'pending',
    "trigger" JSONB,
    "context" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "system_prompt" TEXT,
    "handoff_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "source_url" TEXT,
    "content" TEXT NOT NULL,
    "status" "knowledge_document_status" NOT NULL DEFAULT 'pending',
    "indexed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canned_responses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shortcut" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_shared" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "canned_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_minor_units" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "interval" "billing_interval" NOT NULL DEFAULT 'month',
    "entitlements" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "provider_price_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'trialing',
    "seats" INTEGER NOT NULL DEFAULT 1,
    "provider_customer_id" TEXT,
    "provider_subscription_id" TEXT,
    "current_period_start" TIMESTAMPTZ(3),
    "current_period_end" TIMESTAMPTZ(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "status" "webhook_event_status" NOT NULL DEFAULT 'received',
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" "idempotency_key_state" NOT NULL DEFAULT 'in_progress',
    "status_code" INTEGER,
    "response_body" JSONB,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" UUID,
    "metadata" JSONB,
    "ip_address" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domains_hostname_key" ON "tenant_domains"("hostname");

-- CreateIndex
CREATE INDEX "tenant_domains_tenant_id_idx" ON "tenant_domains"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_branding_tenant_id_key" ON "tenant_branding"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_settings_tenant_id_key" ON "tenant_settings"("tenant_id");

-- CreateIndex
CREATE INDEX "users_tenant_id_status_idx" ON "users"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_id_key" ON "users"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_tenant_id_user_id_idx" ON "sessions"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");

-- CreateIndex
CREATE INDEX "invites_tenant_id_email_idx" ON "invites"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "invites_tenant_id_invited_by_user_id_idx" ON "invites"("tenant_id", "invited_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_tenant_id_name_key" ON "teams"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "teams_tenant_id_id_key" ON "teams"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "team_members_tenant_id_user_id_idx" ON "team_members"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_tenant_id_team_id_user_id_key" ON "team_members"("tenant_id", "team_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_accounts_phone_number_id_key" ON "whatsapp_accounts"("phone_number_id");

-- CreateIndex
CREATE INDEX "whatsapp_accounts_tenant_id_idx" ON "whatsapp_accounts"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_accounts_tenant_id_id_key" ON "whatsapp_accounts"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "message_templates_tenant_id_whatsapp_account_id_idx" ON "message_templates"("tenant_id", "whatsapp_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_tenant_id_name_language_key" ON "message_templates"("tenant_id", "name", "language");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_created_at_id_idx" ON "contacts"("tenant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "contacts_tenant_id_phone_e164_key" ON "contacts"("tenant_id", "phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_tenant_id_id_key" ON "contacts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_tenant_id_name_key" ON "tags"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tags_tenant_id_id_key" ON "tags"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "contact_tags_tenant_id_tag_id_idx" ON "contact_tags"("tenant_id", "tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_tags_tenant_id_contact_id_tag_id_key" ON "contact_tags"("tenant_id", "contact_id", "tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_defs_tenant_id_key_key" ON "custom_field_defs"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_status_last_message_at_id_idx" ON "conversations"("tenant_id", "status", "last_message_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "conversations_tenant_id_assigned_user_id_status_idx" ON "conversations"("tenant_id", "assigned_user_id", "status");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_assigned_team_id_status_idx" ON "conversations"("tenant_id", "assigned_team_id", "status");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_contact_id_idx" ON "conversations"("tenant_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_tenant_id_whatsapp_account_id_contact_id_key" ON "conversations"("tenant_id", "whatsapp_account_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_tenant_id_id_key" ON "conversations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "messages_tenant_id_conversation_id_sent_at_id_idx" ON "messages"("tenant_id", "conversation_id", "sent_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "messages_tenant_id_sender_user_id_idx" ON "messages"("tenant_id", "sender_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_tenant_id_provider_message_id_key" ON "messages"("tenant_id", "provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_tenant_id_id_key" ON "messages"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "message_attachments_tenant_id_message_id_idx" ON "message_attachments"("tenant_id", "message_id");

-- CreateIndex
CREATE INDEX "internal_notes_tenant_id_conversation_id_created_at_id_idx" ON "internal_notes"("tenant_id", "conversation_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "internal_notes_tenant_id_author_user_id_idx" ON "internal_notes"("tenant_id", "author_user_id");

-- CreateIndex
CREATE INDEX "tickets_tenant_id_status_priority_created_at_idx" ON "tickets"("tenant_id", "status", "priority", "created_at" DESC);

-- CreateIndex
CREATE INDEX "tickets_tenant_id_assigned_user_id_status_idx" ON "tickets"("tenant_id", "assigned_user_id", "status");

-- CreateIndex
CREATE INDEX "tickets_tenant_id_assigned_team_id_status_idx" ON "tickets"("tenant_id", "assigned_team_id", "status");

-- CreateIndex
CREATE INDEX "tickets_tenant_id_conversation_id_idx" ON "tickets"("tenant_id", "conversation_id");

-- CreateIndex
CREATE INDEX "tickets_tenant_id_contact_id_idx" ON "tickets"("tenant_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_tenant_id_number_key" ON "tickets"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_tenant_id_id_key" ON "tickets"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "ticket_events_tenant_id_ticket_id_created_at_id_idx" ON "ticket_events"("tenant_id", "ticket_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ticket_events_tenant_id_actor_user_id_idx" ON "ticket_events"("tenant_id", "actor_user_id");

-- CreateIndex
CREATE INDEX "assignment_rules_tenant_id_is_active_position_idx" ON "assignment_rules"("tenant_id", "is_active", "position");

-- CreateIndex
CREATE INDEX "assignment_rules_tenant_id_target_user_id_idx" ON "assignment_rules"("tenant_id", "target_user_id");

-- CreateIndex
CREATE INDEX "assignment_rules_tenant_id_target_team_id_idx" ON "assignment_rules"("tenant_id", "target_team_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_state_team_id_key" ON "assignment_state"("team_id");

-- CreateIndex
CREATE INDEX "assignment_state_tenant_id_last_assigned_user_id_idx" ON "assignment_state"("tenant_id", "last_assigned_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_state_tenant_id_team_id_key" ON "assignment_state"("tenant_id", "team_id");

-- CreateIndex
CREATE INDEX "sla_policies_tenant_id_is_active_priority_idx" ON "sla_policies"("tenant_id", "is_active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_tenant_id_name_key" ON "sla_policies"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_tenant_id_id_key" ON "sla_policies"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sla_timers_tenant_id_state_due_at_idx" ON "sla_timers"("tenant_id", "state", "due_at");

-- CreateIndex
CREATE INDEX "sla_timers_tenant_id_policy_id_idx" ON "sla_timers"("tenant_id", "policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_timers_tenant_id_ticket_id_kind_key" ON "sla_timers"("tenant_id", "ticket_id", "kind");

-- CreateIndex
CREATE INDEX "workflows_tenant_id_is_active_idx" ON "workflows"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_tenant_id_name_key" ON "workflows"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_tenant_id_id_key" ON "workflows"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "workflow_runs_tenant_id_workflow_id_created_at_id_idx" ON "workflow_runs"("tenant_id", "workflow_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "workflow_runs_tenant_id_status_idx" ON "workflow_runs"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_configs_tenant_id_key" ON "ai_configs"("tenant_id");

-- CreateIndex
CREATE INDEX "knowledge_documents_tenant_id_status_idx" ON "knowledge_documents"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "canned_responses_tenant_id_created_by_user_id_idx" ON "canned_responses"("tenant_id", "created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "canned_responses_tenant_id_shortcut_key" ON "canned_responses"("tenant_id", "shortcut");

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_provider_subscription_id_key" ON "subscriptions"("provider_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_provider_customer_id_idx" ON "subscriptions"("provider_customer_id");

-- CreateIndex
CREATE INDEX "subscriptions_plan_id_idx" ON "subscriptions"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_tenant_id_metric_period_start_key" ON "usage_counters"("tenant_id", "metric", "period_start");

-- CreateIndex
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_tenant_id_idx" ON "webhook_events"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_provider_event_id_key" ON "webhook_events"("provider", "provider_event_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_key_key" ON "idempotency_keys"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_id_idx" ON "audit_logs"("tenant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_actor_user_id_idx" ON "audit_logs"("tenant_id", "actor_user_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_target_type_target_id_idx" ON "audit_logs"("tenant_id", "target_type", "target_id");

-- AddForeignKey
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_id_invited_by_user_id_fkey" FOREIGN KEY ("tenant_id", "invited_by_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_tenant_id_team_id_fkey" FOREIGN KEY ("tenant_id", "team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenant_id_whatsapp_account_id_fkey" FOREIGN KEY ("tenant_id", "whatsapp_account_id") REFERENCES "whatsapp_accounts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tenant_id_tag_id_fkey" FOREIGN KEY ("tenant_id", "tag_id") REFERENCES "tags"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_defs" ADD CONSTRAINT "custom_field_defs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_whatsapp_account_id_fkey" FOREIGN KEY ("tenant_id", "whatsapp_account_id") REFERENCES "whatsapp_accounts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_assigned_user_id_fkey" FOREIGN KEY ("tenant_id", "assigned_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_assigned_team_id_fkey" FOREIGN KEY ("tenant_id", "assigned_team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_sender_user_id_fkey" FOREIGN KEY ("tenant_id", "sender_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_tenant_id_message_id_fkey" FOREIGN KEY ("tenant_id", "message_id") REFERENCES "messages"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_tenant_id_author_user_id_fkey" FOREIGN KEY ("tenant_id", "author_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_assigned_user_id_fkey" FOREIGN KEY ("tenant_id", "assigned_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_assigned_team_id_fkey" FOREIGN KEY ("tenant_id", "assigned_team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_tenant_id_ticket_id_fkey" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_tenant_id_actor_user_id_fkey" FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_tenant_id_target_user_id_fkey" FOREIGN KEY ("tenant_id", "target_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_tenant_id_target_team_id_fkey" FOREIGN KEY ("tenant_id", "target_team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assignment_state" ADD CONSTRAINT "assignment_state_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_state" ADD CONSTRAINT "assignment_state_tenant_id_team_id_fkey" FOREIGN KEY ("tenant_id", "team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_state" ADD CONSTRAINT "assignment_state_tenant_id_last_assigned_user_id_fkey" FOREIGN KEY ("tenant_id", "last_assigned_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_timers" ADD CONSTRAINT "sla_timers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_timers" ADD CONSTRAINT "sla_timers_tenant_id_ticket_id_fkey" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_timers" ADD CONSTRAINT "sla_timers_tenant_id_policy_id_fkey" FOREIGN KEY ("tenant_id", "policy_id") REFERENCES "sla_policies"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_tenant_id_workflow_id_fkey" FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "workflows"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_responses" ADD CONSTRAINT "canned_responses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_responses" ADD CONSTRAINT "canned_responses_tenant_id_created_by_user_id_fkey" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_actor_user_id_fkey" FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
