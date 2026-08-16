-- Reverses 20260815150000_ai_chatbot_knowledge_base_and_handoff.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE RUNNING IT: what it destroys
-- ---------------------------------------------------------------------------
--
-- Reversible, not free. Four kinds of data go, and none can be reconstructed
-- from what is left behind:
--
--   * **`knowledge_chunks` in its entirety.** Derived data — every chunk can be
--     rebuilt by re-running `ai.index-document` for each document, because
--     `knowledge_documents.content` survives. This is the one loss here that is
--     genuinely recoverable, and `chunk_count` going with it is what tells you
--     which documents need it.
--   * **`bot_turns` in its entirety.** The idempotency ledger and the tuning data
--     set. Losing the ledger has an operational edge: a bot turn whose row is
--     gone is no longer de-duplicated, so an `ai.handle-inbound` job still in
--     Redis for a message the bot already answered could send a **second WhatsApp
--     message to a customer**. Drain the `ai` queue before running this.
--   * **`handoff_events` in its entirety.** Why each conversation left the bot.
--     The bot's replies themselves survive — they are `messages` rows — so an
--     agent keeps the transcript and loses the confidence scores and the cited
--     documents that explain it.
--   * **`messages.origin`, `conversations.bot_state` / `bot_engaged_at`, and the
--     three `ai_configs` columns.** `origin` is re-derivable for `contact`,
--     `agent` and `system` (that is the backfill in the up migration) but **not
--     for `bot`**: a bot reply and a workflow reply are both outbound with a null
--     sender, and after this runs nothing distinguishes them. Any tenant-tuned
--     `min_confidence`, `max_bot_turns` or `handoff_message` is lost and returns
--     to the default on re-apply.
--
-- Take a verified backup first. On any database where TAR-406 has run a real bot
-- turn, the forward fix is a new migration rather than this.
--
-- ---------------------------------------------------------------------------
-- What it deliberately does not do
-- ---------------------------------------------------------------------------
--
-- It does not drop `pg_trgm`. The extension is a cluster-level object that costs
-- nothing to leave installed, and dropping it would be indistinguishable from
-- dropping one that was already there for another reason — `CREATE EXTENSION IF
-- NOT EXISTS` in the up migration cannot tell whether it created it. The two
-- indexes that use it go with their table above. `20260810120000`'s down.sql
-- removes the baseline extensions if a full teardown is what is wanted.
--
-- ---------------------------------------------------------------------------
-- Order
-- ---------------------------------------------------------------------------
--
-- Children before parents: `handoff_events` references `bot_turns`, both
-- reference `messages` and `conversations`, and `knowledge_chunks` references
-- `knowledge_documents`. The trigger and its function go before the column it
-- completes, so a partial run leaves nothing orphaned. The enum types go last,
-- because a type cannot be dropped while a column still has it. Policies,
-- indexes and constraints go with their tables and need no statement of their
-- own.

SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "public"."handoff_events";

DROP TABLE IF EXISTS "public"."bot_turns";

DROP TABLE IF EXISTS "public"."knowledge_chunks";

DROP TRIGGER IF EXISTS "messages_derive_origin" ON "public"."messages";
DROP FUNCTION IF EXISTS "public"."messages_derive_origin"();

ALTER TABLE "public"."messages"
    DROP CONSTRAINT IF EXISTS "messages_origin_matches_direction";

ALTER TABLE "public"."messages"
    DROP COLUMN IF EXISTS "origin";

ALTER TABLE "public"."conversations"
    DROP CONSTRAINT IF EXISTS "conversations_bot_engaged_at_requires_engagement";

ALTER TABLE "public"."conversations"
    DROP COLUMN IF EXISTS "bot_state",
    DROP COLUMN IF EXISTS "bot_engaged_at";

DROP INDEX IF EXISTS "public"."knowledge_documents_tenant_id_id_key";
DROP INDEX IF EXISTS "public"."knowledge_documents_tenant_id_created_at_id_idx";

ALTER TABLE "public"."knowledge_documents"
    DROP CONSTRAINT IF EXISTS "knowledge_documents_chunk_count_non_negative";

ALTER TABLE "public"."knowledge_documents"
    DROP COLUMN IF EXISTS "language",
    DROP COLUMN IF EXISTS "chunk_count",
    DROP COLUMN IF EXISTS "index_error";

ALTER TABLE "public"."ai_configs"
    DROP CONSTRAINT IF EXISTS "ai_configs_min_confidence_range",
    DROP CONSTRAINT IF EXISTS "ai_configs_max_bot_turns_range";

ALTER TABLE "public"."ai_configs"
    DROP COLUMN IF EXISTS "min_confidence",
    DROP COLUMN IF EXISTS "max_bot_turns",
    DROP COLUMN IF EXISTS "handoff_message";

DROP TYPE IF EXISTS "public"."handoff_reason";
DROP TYPE IF EXISTS "public"."bot_turn_outcome";
DROP TYPE IF EXISTS "public"."message_origin";
DROP TYPE IF EXISTS "public"."conversation_bot_state";
