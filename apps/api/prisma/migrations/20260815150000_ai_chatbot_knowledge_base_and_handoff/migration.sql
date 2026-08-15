-- AI chatbot: knowledge base, chatbot configuration and handoff state
-- (TAR-402, phase 1 of ADR 0010).
--
-- Everything in
-- `docs/architecture/0010-ai-chatbot-knowledge-base-and-handoff.md` that is a
-- table, a column, an enum or a constraint. Nothing here decides anything: the
-- retrieval strategy (decision 2), the confidence rule (decision 3), the state
-- machine (decision 5) and the `origin` column (decision 14) are that document's,
-- and this file expresses them. Where it adds a constraint the design does not
-- name, the comment says so and says why.
--
-- ---------------------------------------------------------------------------
-- What lands, in one migration and why that is safe
-- ---------------------------------------------------------------------------
--
--   1. `pg_trgm`, the one extension decision 2 needs. Contrib, like the
--      `pgcrypto`/`citext` baseline — not `pgvector`, which is third-party and
--      is deliberately not required by this design.
--   2. Four new enum types. New *types*, so the PostgreSQL rule that forbids
--      using a label in the transaction that added it does not apply — that rule
--      is about `ALTER TYPE ... ADD VALUE`, which this file does not use. This is
--      why the vocabulary and the tables can share one migration where
--      `20260815120000`/`20260815130000` had to be split.
--   3. Columns on four existing tables: `ai_configs`, `knowledge_documents`,
--      `conversations`, `messages`.
--   4. Three new tables: `knowledge_chunks`, `bot_turns`, `handoff_events`, each
--      with its `tenant_isolation` policy in this same migration.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds on any realistic estate, and the one statement
--                that scales with traffic is bounded on purpose. Every
--                `ADD COLUMN` is either nullable-with-no-default or
--                constant-default, both of which PostgreSQL 11+ records in the
--                catalogue without rewriting the table. The single backfill
--                (`messages.origin`) touches **outbound rows only** — see
--                section 6 — rather than every message ever received.
--   Locks        ACCESS EXCLUSIVE on `ai_configs`, `knowledge_documents`,
--                `conversations` and `messages` for their ALTERs and index
--                builds, held to the end of the transaction because Prisma wraps
--                the file in one. Capped at three seconds by `lock_timeout`, so a
--                migration that cannot get the lock aborts instead of queueing
--                the inbox behind it. The three new tables lock nothing anyone
--                else can see.
--   Blocking     `messages` and `conversations` are the two hottest tables in the
--                product; inbound ingest and the inbox both queue behind these
--                ALTERs for their duration. That duration is the backfill's, which
--                is why the backfill is bounded rather than table-wide.
--   Rewrite      None. `messages.origin` is added WITH a constant default, which
--                is the O(1) path — the default is stored once in
--                `pg_attribute.attmissingval` and existing rows read it without
--                being touched — and it also removes the validating scan a later
--                `SET NOT NULL` would have cost. Section 6 explains why that
--                default is the correct one to seed and what completes it.
--   Rollback     `down.sql` beside this file. Reversible; the data it destroys is
--                named there, loudly.
--
-- ---------------------------------------------------------------------------
-- Re-run `pnpm db:roles` after applying this
-- ---------------------------------------------------------------------------
--
-- Three new tables. `app-roles.sql` grants them to the application roles and
-- attaches their `system_unrestricted` policy; until it is re-run,
-- `whatsappcrm_app` holds no privilege on any of them (TAR-95 — the grant waits
-- for the policy, deliberately) and `pnpm db:verify:rls` fails by name.
--
-- `app-roles.sql` itself needs no edit: it sweeps the catalogue, and none of these
-- three is append-only or otherwise special.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. `pg_trgm`
-- ---------------------------------------------------------------------------
--
-- The second retriever in decision 2: `similarity()` over chunk text, for the
-- vocabulary mismatch that `'simple'` full-text search (no stemming) cannot
-- cover. Contrib, so it is present wherever `pgcrypto` and `citext` already are.
--
-- Catalogue-only, blocks nothing.

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ---------------------------------------------------------------------------
-- 2. The vocabulary
-- ---------------------------------------------------------------------------

-- Decision 5. Four values, not three: TAR-28 names bot-active, handed-off and
-- human-active, and `off` exists because "the bot never engaged" and "the bot
-- gave up" are different facts the console has to render differently. An
-- empty-knowledge-base tenant's inbox must not look like a tenant whose bot is
-- failing.
CREATE TYPE "conversation_bot_state" AS ENUM ('off', 'bot_active', 'handed_off', 'human_active');

-- Decision 14. `sentByAutomation` is derived from `sender_user_id IS NULL`, and
-- TAR-27's workflows are about to send messages with a null sender too — so that
-- flag stops distinguishing a bot reply from a workflow reply, and TAR-408 has to
-- badge exactly one of them.
--
-- `workflow` is deliberately absent: it is TAR-27's value to append when its send
-- action lands (0009 claims no column of its own for message authorship, so this
-- is a shared seam). The enum is written to be extended rather than replaced.
CREATE TYPE "message_origin" AS ENUM ('contact', 'agent', 'bot', 'system');

CREATE TYPE "bot_turn_outcome" AS ENUM ('replied', 'handed_off', 'suppressed');

-- The published `HANDOFF_REASONS` list, in the contract's order.
CREATE TYPE "handoff_reason" AS ENUM (
    'low_confidence',
    'no_match',
    'customer_requested',
    'max_turns',
    'agent_requested',
    'bot_error'
);

-- ---------------------------------------------------------------------------
-- 3. `ai_configs` — the three columns the gate reads
-- ---------------------------------------------------------------------------
--
-- TAR-39 left this table with `is_enabled`, `model`, `system_prompt` and
-- `handoff_keywords`. Decision 3's threshold, the loop-breaker and the handoff
-- notice are what the gate and the turn need on top.
--
-- Constant defaults, so this is catalogue-only: a tenant with a row written
-- before today reads 0.60 and 5 without being updated, and a tenant with no row
-- at all reads the same numbers from `@whatsappcrm/contracts` (the row is created
-- on first write, on `SlaPolicyService`'s precedent).

ALTER TABLE "ai_configs"
    ADD COLUMN "min_confidence" NUMERIC(3, 2) NOT NULL DEFAULT 0.60,
    ADD COLUMN "max_bot_turns" INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN "handoff_message" TEXT;

-- Both bounds are in the design as CHECK constraints rather than "zod validates
-- it", and the difference is the point: zod guards the one HTTP handler that
-- writes this row today, and the database guards every writer there will ever be
-- — a backfill, a support script, a second endpoint. A threshold outside 0..1
-- makes decision 3's composite score meaningless in the direction that matters
-- (a negative floor admits every answer the model is willing to give).
--
-- Prisma's schema language has no syntax for CHECK and its describer ignores
-- them, so these live only here and only `ai-chatbot-schema.int-spec.ts` notices
-- if one is dropped. The same arrangement `audit_logs_actor_attribution` and
-- `tenants_deleted_at_matches_status` document.
ALTER TABLE "ai_configs"
    ADD CONSTRAINT "ai_configs_min_confidence_range" CHECK (
        "min_confidence" >= 0 AND "min_confidence" <= 1
    );

ALTER TABLE "ai_configs"
    ADD CONSTRAINT "ai_configs_max_bot_turns_range" CHECK (
        "max_bot_turns" >= 1 AND "max_bot_turns" <= 20
    );

COMMENT ON COLUMN "ai_configs"."min_confidence" IS
    '0010 decision 3. The floor the composite score min(modelConfidence, retrievalConfidence) must '
    'reach for the bot to reply rather than hand off. Default 0.60 = "the model must be at least '
    'medium, and retrieval at least solid". A starting value, not a measured one (open question 4).';

COMMENT ON COLUMN "ai_configs"."max_bot_turns" IS
    '0010. Bot replies allowed in one conversation before handoff:max_turns. The loop-breaker for '
    'a bot and a customer talking past each other.';

COMMENT ON COLUMN "ai_configs"."handoff_message" IS
    '0010. Sent to the customer once per conversation on handoff. NULL = say nothing, and that is '
    'the default: a tenant that hands off on every unmatched greeting would otherwise spam.';

-- `model` stays free text in the database on purpose. The allowlist is
-- `AI_MODELS` in `@whatsappcrm/contracts`, checked at the API boundary
-- (decision 10) — a CHECK here would make adding a model id a migration, and
-- model ids change on the provider's schedule rather than ours.

-- ---------------------------------------------------------------------------
-- 4. `knowledge_documents` — indexing state the console renders
-- ---------------------------------------------------------------------------

ALTER TABLE "knowledge_documents"
    ADD COLUMN "language" TEXT,
    ADD COLUMN "chunk_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "index_error" TEXT;

ALTER TABLE "knowledge_documents"
    ADD CONSTRAINT "knowledge_documents_chunk_count_non_negative" CHECK ("chunk_count" >= 0);

COMMENT ON COLUMN "knowledge_documents"."language" IS
    '0010 decision 2. BCP 47, for the console and for a future per-language partial index. NOT '
    'consulted by retrieval: the search vector is generated with the ''simple'' configuration, which '
    'a generated column forces to be a literal, so a per-tenant or per-document regconfig cannot '
    'reach the query at all.';

COMMENT ON COLUMN "knowledge_documents"."chunk_count" IS
    '0010. Denormalised from knowledge_chunks so the console can render "indexed, 14 chunks" '
    'without a count query per row. Maintained by KnowledgeIndexer in the same transaction as the '
    'delete-and-insert reindex.';

COMMENT ON COLUMN "knowledge_documents"."index_error" IS
    '0010. Why status = ''failed''. Operator-facing; never rendered to a customer, and never a '
    'prompt or a provider key.';

-- Convention 2's other half. `knowledge_chunks` references this table by
-- `(tenant_id, id)`, and that composite foreign key needs a unique index to point
-- at — without it a chunk row could name another tenant's document and the
-- database would accept it. TAR-39 did not add one because nothing referenced
-- `knowledge_documents` yet.
--
-- Created as a plain unique index rather than a constraint, matching what Prisma
-- emits for `@@unique([tenantId, id])` elsewhere in this schema.
CREATE UNIQUE INDEX "knowledge_documents_tenant_id_id_key"
    ON "knowledge_documents"("tenant_id", "id");

-- The console's list endpoint: this tenant's documents, newest first, keyset
-- paginated on `(created_at DESC, id DESC)` per 0002 rule 3. The existing
-- `(tenant_id, status)` index serves the `status` filter and the readiness check;
-- neither serves the default page order.
CREATE INDEX "knowledge_documents_tenant_id_created_at_id_idx"
    ON "knowledge_documents"("tenant_id", "created_at" DESC, "id" DESC);

-- The 256 KiB `content` cap and the 1,000-document per-tenant cap are API-boundary
-- rules in the design (`payload_too_large` and `conflict` respectively), not
-- database constraints. Deliberately left there: the document cap cannot be a
-- CHECK at all — it is a count across rows — and enforcing it in a trigger would
-- put a per-insert aggregate on the write path for a limit whose whole purpose is
-- to produce a specific HTTP error.

-- ---------------------------------------------------------------------------
-- 5. `conversations` — the state machine's column
-- ---------------------------------------------------------------------------
--
-- Decision 5. A constant default, so this is catalogue-only on the second-hottest
-- table in the schema: every existing conversation reads `off`, which is exactly
-- true of all of them.

ALTER TABLE "conversations"
    ADD COLUMN "bot_state" "conversation_bot_state" NOT NULL DEFAULT 'off',
    ADD COLUMN "bot_engaged_at" TIMESTAMPTZ(3);

-- One direction only, and the asymmetry is the design's rather than a
-- simplification. `bot_engaged_at` is "start of the window `botExchange` spans",
-- set on the first `→ bot_active` and cleared on the reset to `off`; it stays NULL
-- through `off → handed_off`, because a conversation the gate refused outright has
-- no bot exchange to span. So: `off` implies no timestamp, and nothing is implied
-- the other way.
--
-- What it catches is the failure that would otherwise be silent: a conversation
-- resolved and reopened whose `bot_state` was reset but whose `bot_engaged_at` was
-- not, which would make `GET …/handoff` span a window that starts in a previous
-- conversation and hand the agent a "prior bot exchange" from last month.
ALTER TABLE "conversations"
    ADD CONSTRAINT "conversations_bot_engaged_at_requires_engagement" CHECK (
        "bot_state" <> 'off' OR "bot_engaged_at" IS NULL
    );

COMMENT ON COLUMN "conversations"."bot_state" IS
    '0010 decision 5. off → bot_active → handed_off → human_active, reset to off when the '
    'conversation is resolved or closed. human_active is terminal for the conversation''s active '
    'life on purpose: a bot that resumes after an agent has spoken talks over a colleague in front '
    'of the customer, and no confidence score prevents that.';

COMMENT ON COLUMN "conversations"."bot_engaged_at" IS
    '0010 decision 6. When the bot took the conversation — the start of the window botExchange '
    'spans. NULL when the bot never replied, and cleared on the reset to off.';

-- No index on `bot_state`, deliberately (design, Data Model). The console filters
-- an already-narrow inbox page and the three existing keyset indexes serve it. A
-- "bot-handled" inbox filter as a *primary* predicate would be a measured index
-- change, not this speculative one.

-- ---------------------------------------------------------------------------
-- 6. `messages.origin` — decision 14, and the one backfill in this file
-- ---------------------------------------------------------------------------
--
-- Two statements, a CHECK and a trigger, in an order chosen so the hottest table
-- in the product is never rewritten and never scanned end to end.
--
-- **Why the column carries a default at all.** A constant default makes
-- `ADD COLUMN` O(1) on PostgreSQL 11+ — the value is recorded once in
-- `pg_attribute.attmissingval` and existing rows are not touched — *and* it
-- satisfies NOT NULL for every one of them without the validating scan a later
-- `SET NOT NULL` would cost on a table that grows with every message ever sent.
--
-- **Why `'contact'` is the right default even though it is wrong for half the
-- rows.** The correct value depends on the row — `direction` and `sender_user_id`
-- — and a column default cannot. `'contact'` seeds the majority case exactly
-- (every inbound message *is* contact-authored), the minority is corrected by the
-- bounded UPDATE below for rows that already exist and by the trigger for rows
-- written from now on, and the CHECK constraint makes an uncorrected outbound row
-- impossible to store rather than merely unlikely. The default is never observable
-- as a wrong answer: it is a seed value that one of those two mechanisms always
-- completes.

ALTER TABLE "messages"
    ADD COLUMN "origin" "message_origin" NOT NULL DEFAULT 'contact';

-- The design's backfill, restricted to the rows the default got wrong.
-- `direction = 'inbound'` already reads `'contact'` and is skipped entirely,
-- which is what keeps this bounded on a table that grows with every customer
-- message ever received.
--
-- Existing automation rows become `system`, not `bot`. That is the honest answer:
-- nothing before this story was a bot.
DO $$
DECLARE
    corrected bigint;
BEGIN
    UPDATE "public"."messages"
       SET "origin" = CASE
               WHEN "sender_user_id" IS NOT NULL THEN 'agent'::"message_origin"
               ELSE 'system'::"message_origin"
           END
     WHERE "direction" = 'outbound';

    GET DIAGNOSTICS corrected = ROW_COUNT;

    RAISE NOTICE 'messages.origin: classified % outbound message(s); inbound rows read the default', corrected;
END
$$;

-- The invariant, and it is exact rather than approximate: a message is
-- contact-authored if and only if it came *from* the contact. `agent`, `bot` and
-- `system` are outbound-only labels, and `contact` on an outbound row is not a
-- degraded value — it is a false statement about who wrote the message.
--
-- It is also what makes the trigger below sound: `contact` on an outbound insert
-- can only mean "the writer did not say", because no writer could legitimately
-- mean it.
ALTER TABLE "messages"
    ADD CONSTRAINT "messages_origin_matches_direction" CHECK (
        ("direction" = 'inbound') = ("origin" = 'contact')
    );

-- **Why a trigger and not "the writers will pass it".**
--
-- This migration lands before TAR-406, and `origin` has no writer until it does:
-- `WhatsAppInboundWriter`, `MessageSendService`, the seed, the isolation fixture
-- in `verify-tenant-isolation.sql` and the restore-drill canary all insert
-- messages today without naming it. With the CHECK above and no trigger, every
-- agent send in the product would fail at the database the moment this deploys —
-- and without the CHECK they would all be silently recorded as written by the
-- customer.
--
-- The trigger applies the same rule as the backfill, to the same rows, at insert
-- time. It is a `COALESCE`-shaped completion rather than an override: a writer
-- that names `bot`, `agent` or `system` is left alone, so TAR-406 sets `bot`
-- explicitly and this becomes invisible to it.
--
-- INSERT only. `direction` and `sender_user_id` are written once and never
-- updated, so there is no second moment at which the derivation could change, and
-- the CHECK constraint — which is enforced on UPDATE too — is what guards the
-- invariant afterwards.
--
-- Cost: one plpgsql call per message insert, and only outbound rows do any work.
-- Named here so it is a reviewed cost rather than a discovered one; it is
-- removable in one statement once every writer names its origin.
CREATE FUNCTION "public"."messages_derive_origin"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW."direction" = 'outbound' AND NEW."origin" = 'contact' THEN
        NEW."origin" := CASE
            WHEN NEW."sender_user_id" IS NOT NULL THEN 'agent'::"public"."message_origin"
            ELSE 'system'::"public"."message_origin"
        END;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."messages_derive_origin"() IS
    '0010 decision 14 (TAR-402). Completes messages.origin for writers that predate it: an '
    'outbound row left at ''contact'' — which no writer could legitimately mean, per '
    'messages_origin_matches_direction — is classified from sender_user_id. A writer that names '
    'bot, agent or system is left untouched.';

CREATE TRIGGER "messages_derive_origin"
    BEFORE INSERT ON "public"."messages"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."messages_derive_origin"();

COMMENT ON COLUMN "messages"."origin" IS
    '0010 decision 14. Who authored the message: contact | agent | bot | system. Published '
    'alongside sentByAutomation, which keeps its meaning (origin NOT IN (contact, agent)) so no '
    'existing client breaks. TAR-27 appends ''workflow'' when its send action lands.';

-- ---------------------------------------------------------------------------
-- 7. `knowledge_chunks`
-- ---------------------------------------------------------------------------
--
-- What retrieval actually reads. A document is the unit a tenant authors and
-- edits; a chunk is the unit that is ranked, put in the prompt, and cited — which
-- is why the citation in `bot_turns` and the `citedChunkIds` the model must return
-- are chunk ids and not document ids.

CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    -- Position within the document. Ordering context for the prompt, and what
    -- makes a citation locatable in the source the tenant authored.
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    -- Generated and STORED, so the vector is written once at index time rather
    -- than recomputed per query, and cannot drift from `content` the way a column
    -- maintained by application code would.
    --
    -- `'simple'` is a literal because a generated column requires an immutable
    -- expression: `to_tsvector(regconfig, text)` is immutable only with the
    -- configuration fixed, so a per-tenant or per-document `regconfig` cannot be a
    -- generated column at all. Decision 2 settles it on that mechanism rather than
    -- on preference — and `'simple'` does no stemming, which is the right trade
    -- for a bilingual Arabic/English product where a wrong stemmer is worse than
    -- none.
    "search_vector" TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_chunks_tenant_id_id_key" ON "knowledge_chunks"("tenant_id", "id");

-- Reindexing is delete-and-insert inside one transaction, keyed on the document
-- (design, Data Model). This is what makes a half-written chunk set impossible:
-- two concurrent indexers cannot both write ordinal 3 of the same document, so a
-- retrieval running alongside an edit sees the old set or the new one and never a
-- mixture. A partially reindexed document is exactly a confidently wrong answer.
CREATE UNIQUE INDEX "knowledge_chunks_tenant_id_document_id_ordinal_key"
    ON "knowledge_chunks"("tenant_id", "document_id", "ordinal");

-- The reindex's own delete, and the console's per-document chunk read.
CREATE INDEX "knowledge_chunks_tenant_id_document_id_idx"
    ON "knowledge_chunks"("tenant_id", "document_id");

ALTER TABLE "knowledge_chunks"
    ADD CONSTRAINT "knowledge_chunks_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite, against `knowledge_documents(tenant_id, id)` — never `(id)` alone
-- (convention 2). CASCADE because a chunk without its document is garbage: the
-- document is the source of truth and the chunk is a derived artefact of it.
ALTER TABLE "knowledge_chunks"
    ADD CONSTRAINT "knowledge_chunks_tenant_id_document_id_fkey"
    FOREIGN KEY ("tenant_id", "document_id") REFERENCES "knowledge_documents"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_chunks"
    ADD CONSTRAINT "knowledge_chunks_ordinal_non_negative" CHECK ("ordinal" >= 0);

-- The two retrieval indexes. `schema.prisma` declares both — `@@index(...,
-- type: Gin)` with a raw operator class — so `prisma migrate diff` reports no
-- drift on them; they are written out here because the whole file is
-- hand-written and an index this load-bearing should be readable in the
-- migration that creates it rather than only inferable from a generator.
--
--   * The first serves `websearch_to_tsquery` ranked by `ts_rank_cd` — the primary
--     retriever.
--   * The second serves the `similarity()` pass that runs when full-text search
--     returns nothing, which is decision 2's partial answer to vocabulary
--     mismatch ("can I get my money back" against a KB that says "refund policy").
--
-- Neither leads with `tenant_id`, which is the one place this file departs from
-- convention 3, and it is a mechanical limit rather than a choice: a GIN index
-- cannot lead with a btree column without `btree_gin`, a fourth extension. RLS
-- and `KnowledgeRetriever`'s explicit `tenantId` predicate both still filter the
-- result — this costs a wider index scan, not a cross-tenant read. At the scale
-- decision 2 designs for (tens of documents, hundreds of chunks per tenant) that
-- is not the weak point; if it becomes one, `btree_gin` and a composite GIN index
-- are the measured change.
CREATE INDEX "knowledge_chunks_search_idx" ON "knowledge_chunks" USING GIN ("search_vector");

CREATE INDEX "knowledge_chunks_content_trgm_idx"
    ON "knowledge_chunks" USING GIN ("content" gin_trgm_ops);

COMMENT ON TABLE "knowledge_chunks" IS
    '0010 decision 2. The retrieval unit: paragraph-packed slices of a knowledge document, ranked '
    'by PostgreSQL full-text search with a pg_trgm similarity pass as the fallback retriever. No '
    'embedding column — pgvector is deferred with a measurable revisit signal (the share of turns '
    'ending handoff:no_match against a KB that does contain the answer), and the schema stays '
    'additive so adding one later is a column and a second retriever.';

-- ---------------------------------------------------------------------------
-- 8. `bot_turns`
-- ---------------------------------------------------------------------------
--
-- Three jobs, each load-bearing: the idempotency ledger, the audit trail, and the
-- data set that makes decision 3's constants re-tunable by query rather than by
-- research.

CREATE TABLE "bot_turns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "inbound_message_id" UUID NOT NULL,
    "outcome" "bot_turn_outcome" NOT NULL,
    "handoff_reason" "handoff_reason",
    -- The composite and its two components, stored separately so a re-tune is a
    -- query. numeric(4,3): three decimals is finer than any of these signals
    -- deserves, and the range check below is what keeps the fourth digit from
    -- meaning something.
    "score" NUMERIC(4, 3),
    "model_confidence" NUMERIC(4, 3),
    "retrieval_score" NUMERIC(4, 3),
    "reply_message_id" UUID,
    -- Written once, read with the turn, never queried the other way — so a plain
    -- array rather than a join table, on `internal_notes.mentioned_user_ids`'
    -- precedent.
    "cited_chunk_ids" UUID[] NOT NULL DEFAULT '{}',
    -- The id actually used, not the configured one: `ai_configs.model` may be NULL
    -- for "the platform default", and a turn has to record which model produced it
    -- after the default moves.
    "model" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cached_input_tokens" INTEGER,
    "latency_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_turns_pkey" PRIMARY KEY ("id")
);

-- **The guard that makes a double reply impossible**, and the reason this table is
-- written before the model is called rather than after it.
--
-- A deterministic BullMQ `jobId` de-duplicates a re-enqueue; it does not
-- de-duplicate a worker that crashed after the send and before the ack, which is
-- the case that costs a customer a second WhatsApp message. That is visible and
-- unrecoverable, so the guard is a row and a unique index rather than a queue
-- property.
CREATE UNIQUE INDEX "bot_turns_tenant_id_inbound_message_id_key"
    ON "bot_turns"("tenant_id", "inbound_message_id");

-- Referenced by `handoff_events(tenant_id, bot_turn_id)` (convention 2).
CREATE UNIQUE INDEX "bot_turns_tenant_id_id_key" ON "bot_turns"("tenant_id", "id");

-- The handoff-context read: this conversation's turns, newest first (0002 rule 3).
CREATE INDEX "bot_turns_tenant_id_conversation_id_created_at_id_idx"
    ON "bot_turns"("tenant_id", "conversation_id", "created_at" DESC, "id" DESC);

-- The tuning queries decisions 2 and 3 name: the outcome mix over time, and the
-- `no_match` share that is decision 2's revisit signal for pgvector.
CREATE INDEX "bot_turns_tenant_id_outcome_created_at_idx"
    ON "bot_turns"("tenant_id", "outcome", "created_at" DESC);

ALTER TABLE "bot_turns"
    ADD CONSTRAINT "bot_turns_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bot_turns"
    ADD CONSTRAINT "bot_turns_tenant_id_conversation_id_fkey"
    FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CASCADE: the turn is *about* this message and cannot outlive it. It is also
-- what keeps TAR-36's retention from being blocked by an idempotency row.
ALTER TABLE "bot_turns"
    ADD CONSTRAINT "bot_turns_tenant_id_inbound_message_id_fkey"
    FOREIGN KEY ("tenant_id", "inbound_message_id") REFERENCES "messages"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- NO ACTION, per convention 4 for an optional reference: CASCADE here would
-- delete the whole turn — the idempotency guard and the audit of why the bot
-- answered — because the reply it produced was removed. Deferred to end of
-- statement, so the cascade from `conversations` that removes both in one
-- statement still succeeds.
ALTER TABLE "bot_turns"
    ADD CONSTRAINT "bot_turns_tenant_id_reply_message_id_fkey"
    FOREIGN KEY ("tenant_id", "reply_message_id") REFERENCES "messages"("tenant_id", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- A reason belongs to a handoff and to nothing else. Both directions: a
-- `handed_off` turn with no reason cannot answer the question `GET …/handoff`
-- exists to answer, and a reason on a `replied` turn is a contradiction the
-- tuning queries would count.
ALTER TABLE "bot_turns"
    ADD CONSTRAINT "bot_turns_handoff_reason_matches_outcome" CHECK (
        ("outcome" = 'handed_off') = ("handoff_reason" IS NOT NULL)
    );

-- Each score is bounded independently rather than as a group. They genuinely can
-- be present in combinations: a `no_match` turn may record a retrieval score of
-- zero with no model confidence at all, because the model was never called.
ALTER TABLE "bot_turns"
    ADD CONSTRAINT "bot_turns_scores_in_range" CHECK (
        ("score" IS NULL OR ("score" >= 0 AND "score" <= 1))
        AND ("model_confidence" IS NULL OR ("model_confidence" >= 0 AND "model_confidence" <= 1))
        AND ("retrieval_score" IS NULL OR ("retrieval_score" >= 0 AND "retrieval_score" <= 1))
    );

-- Token counts and latencies are measurements. A negative one is a bug in the
-- reader, and it would be averaged into the cost attribution `usage_counters`
-- reports.
ALTER TABLE "bot_turns"
    ADD CONSTRAINT "bot_turns_usage_non_negative" CHECK (
        ("input_tokens" IS NULL OR "input_tokens" >= 0)
        AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
        AND ("cached_input_tokens" IS NULL OR "cached_input_tokens" >= 0)
        AND ("latency_ms" IS NULL OR "latency_ms" >= 0)
    );

COMMENT ON TABLE "bot_turns" IS
    '0010. One row per inbound message the bot considered, inserted BEFORE the model call. '
    'UNIQUE (tenant_id, inbound_message_id) is what makes a double reply impossible. Stores no '
    'prompt and no answer text: the answer is already a messages row, and storing it twice would '
    'double a customer''s data footprint for no reader and make retention two problems.';

COMMENT ON COLUMN "bot_turns"."error" IS
    '0010. A classified failure label — timeout, refusal, max_tokens, malformed_output. Never a '
    'prompt, never a provider key, never customer content.';

-- ---------------------------------------------------------------------------
-- 9. `handoff_events`
-- ---------------------------------------------------------------------------

CREATE TABLE "handoff_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    -- NULL when the linker produced no ticket for the triggering message.
    "ticket_id" UUID,
    "reason" "handoff_reason" NOT NULL,
    -- The customer message that ended the bot's run: the question the agent now
    -- has to answer.
    "trigger_message_id" UUID NOT NULL,
    -- NULL for `customer_requested` and `no_match` — the model was never called,
    -- so there is no scored turn to point at.
    "bot_turn_id" UUID,
    "bot_engaged_at" TIMESTAMPTZ(3),
    "bot_reply_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handoff_events_pkey" PRIMARY KEY ("id")
);

-- **Not unique per conversation**, deliberately: a conversation can be resolved,
-- reopened by a later question, handled by the bot again and handed off again.
-- `GET /conversations/{id}/handoff` returns the most recent row, which is what
-- this index is for (0002 rule 3).
CREATE INDEX "handoff_events_tenant_id_conversation_id_created_at_id_idx"
    ON "handoff_events"("tenant_id", "conversation_id", "created_at" DESC, "id" DESC);

ALTER TABLE "handoff_events"
    ADD CONSTRAINT "handoff_events_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "handoff_events"
    ADD CONSTRAINT "handoff_events_tenant_id_conversation_id_fkey"
    FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "handoff_events"
    ADD CONSTRAINT "handoff_events_tenant_id_trigger_message_id_fkey"
    FOREIGN KEY ("tenant_id", "trigger_message_id") REFERENCES "messages"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "handoff_events"
    ADD CONSTRAINT "handoff_events_tenant_id_ticket_id_fkey"
    FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "handoff_events"
    ADD CONSTRAINT "handoff_events_tenant_id_bot_turn_id_fkey"
    FOREIGN KEY ("tenant_id", "bot_turn_id") REFERENCES "bot_turns"("tenant_id", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "handoff_events"
    ADD CONSTRAINT "handoff_events_bot_reply_count_non_negative" CHECK ("bot_reply_count" >= 0);

-- The same one-directional rule `conversations` carries, for the same reason:
-- `bot_engaged_at` is the start of the window `botExchange` spans, so a handoff
-- that reports replies must say when they started. A handoff with no replies —
-- `customer_requested` on the first message, `no_match` — has nothing to date.
ALTER TABLE "handoff_events"
    ADD CONSTRAINT "handoff_events_engagement_matches_replies" CHECK (
        "bot_reply_count" = 0 OR "bot_engaged_at" IS NOT NULL
    );

COMMENT ON TABLE "handoff_events" IS
    '0010 decision 6. One row per handoff, newest-wins. Carries what the message thread cannot: '
    'why the bot stopped and how sure it was. The bot''s replies themselves are ordinary messages '
    'rows — they were genuinely sent to the customer — so the agent''s thread already holds the '
    'exchange verbatim.';

-- ---------------------------------------------------------------------------
-- 10. Row-level security on the three new tables (TAR-48's mechanism, unchanged)
-- ---------------------------------------------------------------------------
--
-- Same predicate, same `FORCE`, same `TO PUBLIC` role-agnosticism as every other
-- tenant-scoped table. `pnpm db:verify:rls` derives its list from the catalogue
-- rather than from a file, so a table added without this block fails by name.
--
-- The cross-tenant risk unique to this story is the *prompt* rather than the
-- query (design, Security): a prompt assembled with another tenant's chunks would
-- leak content no `where` clause could recover. These policies are the first of
-- the two guards — `BotTurnService` asserting every cited chunk id against the set
-- this turn retrieved is the second, and it is TAR-406's.

ALTER TABLE "public"."knowledge_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."knowledge_chunks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."knowledge_chunks"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "public"."bot_turns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."bot_turns" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."bot_turns"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "public"."handoff_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."handoff_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."handoff_events"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
