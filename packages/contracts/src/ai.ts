import { z } from 'zod';
import { IdSchema, LocaleSchema, TimestampSchema } from './common';
import { MessageResponseSchema } from './messages';
import { CursorPageQuerySchema } from './pagination';

/**
 * The AI chatbot: knowledge base, confidence gating and human handoff (TAR-28),
 * transcribed from
 * `docs/architecture/0010-ai-chatbot-knowledge-base-and-handoff.md`.
 *
 * Three surfaces live here and they are deliberately in one file:
 *
 *   * the **HTTP contract** the console builds against — knowledge-base CRUD,
 *     the per-tenant chatbot configuration, and the handoff context;
 *   * the **internal queue contract** between `TicketsModule` (L3) and
 *     `AiModule` (L4), which neither may import from the other — the same
 *     arrangement `ticket-linking.ts` makes, for the same layering reason;
 *   * the **scoring constants** decision 3 fixes, so the worker, the console and
 *     the tests read the same numbers rather than three copies of them.
 *
 * `ConversationBotState` and `MessageOrigin` are **not** here. They are fields
 * on the inbox's own resources, so they live in `conversations.ts` and
 * `messages.ts`; this file imports them, and nothing imports back.
 */

// ---------------------------------------------------------------------------
// Transport — the two jobs `AiModule` consumes
// ---------------------------------------------------------------------------

/** BullMQ queue owned by `AiModule`. */
export const AI_QUEUE = 'ai';

/**
 * Enqueued by `TicketQueueRunner` after the ticket-linking transaction commits,
 * for the `created` and `attached` outcomes and not for `skipped` (0010
 * decision 1).
 *
 * The trigger is a job rather than a call because `AiModule` is L4: nothing at
 * L3 may import it, so what crosses the line is this shape and the queue name.
 */
export const AI_HANDLE_INBOUND_JOB = 'ai.handle-inbound';

/** Enqueued by the knowledge-base write path once a document commits. */
export const AI_INDEX_DOCUMENT_JOB = 'ai.index-document';

/**
 * What the bot needs to consider one inbound message.
 *
 * Six fields and no more: everything else is reachable from `messageId` and
 * `conversationId`, and a wider payload is a wider thing to keep in step with
 * the schema. The consumer re-reads every row through `TenantPrisma` rather than
 * trusting these values, because a queue payload is unauthenticated input and
 * the read has to happen in tenant scope anyway.
 */
export const BotInboundTriggerSchema = z.object({
  tenantId: IdSchema,
  conversationId: IdSchema,
  contactId: IdSchema,
  messageId: IdSchema,
  /** Null only when the linker produced no ticket — the bot still answers. */
  ticketId: IdSchema.nullable(),
  /** The provider's `sent_at`, matching `InboundMessageTicketTrigger.receivedAt`. */
  receivedAt: TimestampSchema,
});

export type BotInboundTrigger = z.infer<typeof BotInboundTriggerSchema>;

/**
 * Stable BullMQ `jobId`, so a re-enqueue of the same delivery collapses while
 * the first is still queued.
 *
 * An optimisation, not the correctness mechanism: BullMQ forgets a completed
 * job's id, and what actually prevents a second reply is the unique constraint
 * on `bot_turns (tenant_id, inbound_message_id)`.
 *
 * Hyphens, never a colon — BullMQ reserves `:` for its own Redis key structure
 * and rejects a custom id containing one, and `QueueService.enqueue` logs that
 * rejection rather than throwing, so a violation stops the bot silently
 * (TAR-249, and the rule `ticket-linking.ts` already follows).
 */
export function botInboundJobId(trigger: BotInboundTrigger): string {
  return `ai-inbound-${trigger.tenantId}-${trigger.messageId}`;
}

export const IndexKnowledgeDocumentJobSchema = z.object({
  tenantId: IdSchema,
  documentId: IdSchema,
});

export type IndexKnowledgeDocumentJob = z.infer<typeof IndexKnowledgeDocumentJobSchema>;

/** Collapses a re-index of the same document while the first is still queued. */
export function indexKnowledgeDocumentJobId(job: IndexKnowledgeDocumentJob): string {
  return `ai-index-${job.tenantId}-${job.documentId}`;
}

// ---------------------------------------------------------------------------
// The model allowlist
// ---------------------------------------------------------------------------

/**
 * The model ids a tenant may choose (0010 decision 10).
 *
 * An allowlist rather than free text: an unknown id is `validation_failed` at
 * write time instead of a 404 discovered on a live customer message. `null` on
 * `AiConfig.model` means "the platform default", so a tenant that never chooses
 * is not pinned to whatever was current the day their row was written.
 */
export const AI_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;
export const AiModelSchema = z.enum(AI_MODELS);
export type AiModel = (typeof AI_MODELS)[number];

/** The id a tenant with `model: null` is served by. */
export const AI_DEFAULT_MODEL: AiModel = 'claude-opus-5';

export const AiModelOptionSchema = z.object({
  id: AiModelSchema,
  displayName: z.string(),
  inputPricePerMTokUsd: z.number(),
  outputPricePerMTokUsd: z.number(),
  isDefault: z.boolean(),
});

export type AiModelOption = z.infer<typeof AiModelOptionSchema>;

/**
 * The published list prices, so the console can render the cost trade-off where
 * the choice is made rather than hiding a 5× difference behind a dropdown.
 *
 * **List prices at the time of writing.** 0010 decision 10 records that they
 * need re-verification before they are shown to a paying tenant; they are one
 * constant here precisely so that is one edit rather than a hunt through copy.
 */
export const AI_MODEL_CATALOG: readonly AiModelOption[] = [
  {
    id: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    inputPricePerMTokUsd: 5,
    outputPricePerMTokUsd: 25,
    isDefault: true,
  },
  {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    inputPricePerMTokUsd: 3,
    outputPricePerMTokUsd: 15,
    isDefault: false,
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    inputPricePerMTokUsd: 1,
    outputPricePerMTokUsd: 5,
    isDefault: false,
  },
];

// ---------------------------------------------------------------------------
// Scoring — decision 3, in one place
// ---------------------------------------------------------------------------

/** What the model may say about its own answer. Used only as a veto. */
export const BOT_ANSWER_REASONS = ['grounded', 'not_in_kb', 'ambiguous', 'wants_human'] as const;
export const BotAnswerReasonSchema = z.enum(BOT_ANSWER_REASONS);
export type BotAnswerReason = (typeof BOT_ANSWER_REASONS)[number];

export const BOT_MODEL_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export const BotModelConfidenceLevelSchema = z.enum(BOT_MODEL_CONFIDENCE_LEVELS);
export type BotModelConfidenceLevel = (typeof BOT_MODEL_CONFIDENCE_LEVELS)[number];

/**
 * The numbers decision 3 fixes, exported so the worker, the console and the
 * tests read one copy.
 *
 * **Defensible starting values, not measured ones**, stated the way
 * `ASSIGNMENT_POLICY` states its five. `bot_turns` stores `model_confidence` and
 * `retrieval_score` separately so re-tuning them is a query rather than a
 * re-derivation from an aggregate.
 */
export const BOT_CONFIDENCE = {
  /** `modelConfidence` for each level the model may report. */
  modelConfidence: { high: 1, medium: 0.6, low: 0.3 } as Record<BotModelConfidenceLevel, number>,
  /**
   * The `ts_rank_cd` value that counts as full retrieval confidence. Ranks above
   * it clamp to 1; the ratio below it is the retrieval half of the score.
   */
  rankTarget: 0.1,
  /**
   * Below this rank a chunk is not retrieved at all. Zero chunks above the floor
   * means the model is never called (decision 4) and the turn is
   * `handoff:no_match`.
   */
  rankFloor: 0.01,
  /** Trigram similarity a chunk must reach on the fallback retriever. */
  trigramFloor: 0.3,
  /** Chunks put in the prompt, at most. */
  topK: 6,
} as const;

/**
 * The composite score: `min(modelConfidence, retrievalConfidence)`.
 *
 * **`min`, not an average, and that is the whole decision.** An average lets a
 * confident model compensate for weak retrieval, which is precisely the
 * hallucination case this feature exists to prevent. Under `min` neither signal
 * can rescue the other — the bot answers only when the material was there *and*
 * the model says it used it — and the result stays monotone in both inputs, so
 * `minConfidence` keeps a meaning an admin can hold in their head.
 */
export function compositeConfidence(modelConfidence: number, retrievalScore: number): number {
  return Math.min(modelConfidence, retrievalScore);
}

/** `topChunkRank / rankTarget`, clamped to 0..1. */
export function retrievalConfidence(topChunkRank: number): number {
  if (!Number.isFinite(topChunkRank) || topChunkRank <= 0) {
    return 0;
  }

  return Math.min(topChunkRank / BOT_CONFIDENCE.rankTarget, 1);
}

// ---------------------------------------------------------------------------
// Handoff vocabulary
// ---------------------------------------------------------------------------

export const HANDOFF_REASONS = [
  /** The composite score fell below the tenant's threshold. */
  'low_confidence',
  /** Retrieval returned nothing above the floor; the model was never called. */
  'no_match',
  /** A handoff keyword matched. */
  'customer_requested',
  /** `maxBotTurns` reached in this conversation. */
  'max_turns',
  /** An agent took the thread from the console. */
  'agent_requested',
  /** Timeout, refusal, `max_tokens`, malformed output, provider failure. */
  'bot_error',
] as const;
export const HandoffReasonSchema = z.enum(HANDOFF_REASONS);
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export const BOT_TURN_OUTCOMES = ['replied', 'handed_off', 'suppressed'] as const;
export const BotTurnOutcomeSchema = z.enum(BOT_TURN_OUTCOMES);
export type BotTurnOutcome = (typeof BOT_TURN_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Knowledge base — `ai:read` / `ai:write`
// ---------------------------------------------------------------------------

export const KNOWLEDGE_DOCUMENT_STATUSES = ['pending', 'indexed', 'failed'] as const;
export const KnowledgeDocumentStatusSchema = z.enum(KNOWLEDGE_DOCUMENT_STATUSES);
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];

/**
 * The two caps, so "how large can a knowledge base get" has an answer before a
 * tenant finds one. Exceeding `contentBytes` is `validation_failed`, naming the
 * limit; exceeding `documentsPerTenant` is `conflict`.
 *
 * `payload_too_large` is a different failure and a coarser one — the API's JSON
 * body limit, which `configureApp` sets above this cap precisely so a document
 * at the documented size is accepted rather than rejected by the parser before
 * any of this is read.
 */
export const KNOWLEDGE_DOCUMENT_LIMITS = {
  /**
   * 256 KiB of content per document, counted in **UTF-8 bytes** as the name
   * says — not in UTF-16 code units, which would accept roughly twice this much
   * Arabic or Chinese and make the published number mean different things in
   * different languages.
   */
  contentBytes: 262_144,
  titleLength: 200,
  sourceUrlLength: 2048,
  documentsPerTenant: 1_000,
} as const;

export const KnowledgeDocumentResponseSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(KNOWLEDGE_DOCUMENT_LIMITS.titleLength),
  sourceUrl: z.url().nullable(),
  content: z.string(),
  language: LocaleSchema.nullable(),
  status: KnowledgeDocumentStatusSchema,
  /** Denormalised, so the console renders "indexed, 14 chunks" without a count per row. */
  chunkCount: z.int().nonnegative(),
  /** Why `status` is `failed`. Operator-facing; never rendered to a customer. */
  indexError: z.string().nullable(),
  indexedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type KnowledgeDocumentResponse = z.infer<typeof KnowledgeDocumentResponseSchema>;

/**
 * A list item, which is the response **minus `content`**.
 *
 * A 1,000-document page carrying 256 KiB each is a response nobody wants, and
 * the console's list renders the title, the status and the chunk count. The full
 * document is the single read.
 */
export const KnowledgeDocumentListItemSchema = KnowledgeDocumentResponseSchema.omit({
  content: true,
});

export type KnowledgeDocumentListItem = z.infer<typeof KnowledgeDocumentListItemSchema>;

/**
 * The content cap, measured the way it is named.
 *
 * `z.string().max()` counts UTF-16 code units, so the same limit accepted about
 * twice the advertised size in Arabic or Chinese and exactly the advertised size
 * in English — one number meaning two things depending on the tenant's language.
 *
 * Counted by hand rather than with `TextEncoder` or `Buffer.byteLength`: this
 * package is compiled against `lib: ES2023` alone and is consumed by both the
 * API and the browser, so it may assume neither runtime's globals.
 *
 * The length check first is not an optimisation for its own sake. A UTF-8
 * encoding is never shorter than the string's code-unit count, so a string
 * longer than the cap is over it whatever it contains — which both answers the
 * common case in one comparison and bounds the loop below to the cap.
 *
 * **Exported as the predicate rather than as a byte counter**, so a console that
 * wants the same answer before spending a round trip gets the same answer *and*
 * the same bound on the loop: a bare counter handed a 10 MB paste would walk all
 * of it to learn what the first comparison already knew.
 */
export function withinKnowledgeContentCap(content: string): boolean {
  if (content.length > KNOWLEDGE_DOCUMENT_LIMITS.contentBytes) {
    return false;
  }

  let bytes = 0;

  // `for…of` iterates code points, so a surrogate pair is one four-byte
  // character rather than two three-byte ones.
  for (const character of content) {
    const codePoint = character.codePointAt(0) ?? 0;

    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }

  return bytes <= KNOWLEDGE_DOCUMENT_LIMITS.contentBytes;
}

const CONTENT_CAP_MESSAGE = `Content must be at most ${KNOWLEDGE_DOCUMENT_LIMITS.contentBytes} bytes.`;

export const CreateKnowledgeDocumentInputSchema = z.object({
  title: z.string().min(1).max(KNOWLEDGE_DOCUMENT_LIMITS.titleLength),
  content: z.string().min(1).refine(withinKnowledgeContentCap, { message: CONTENT_CAP_MESSAGE }),
  sourceUrl: z.url().max(KNOWLEDGE_DOCUMENT_LIMITS.sourceUrlLength).optional(),
  language: LocaleSchema.optional(),
});

export type CreateKnowledgeDocumentInput = z.infer<typeof CreateKnowledgeDocumentInputSchema>;

/**
 * A partial edit, with one field that is deliberately more than partial.
 *
 * Every key is optional and an omitted one leaves the stored value alone — but
 * `sourceUrl` is also **nullable**, because "there is no source URL any more" is
 * something an admin can mean and absence cannot say. Without it, clearing the
 * field in the console reported "Saved" and changed nothing.
 *
 * `null` is not offered on the create for the same reason it is needed here: on
 * a document that does not exist yet, "clear it" and "do not set it" are the
 * same instruction, and two spellings of one meaning is a choice no caller
 * should have to make.
 */
export const UpdateKnowledgeDocumentInputSchema =
  CreateKnowledgeDocumentInputSchema.partial().extend({
    sourceUrl: z.url().max(KNOWLEDGE_DOCUMENT_LIMITS.sourceUrlLength).nullable().optional(),
  });

export type UpdateKnowledgeDocumentInput = z.infer<typeof UpdateKnowledgeDocumentInputSchema>;

/**
 * `q` is a plain case-insensitive match over `title` — a console filter, not the
 * retrieval path. Keyset-paginated on `(created_at DESC, id DESC)`.
 */
export const KnowledgeDocumentListQuerySchema = CursorPageQuerySchema.extend({
  status: KnowledgeDocumentStatusSchema.optional(),
  q: z.string().min(1).max(120).optional(),
});

export type KnowledgeDocumentListQuery = z.infer<typeof KnowledgeDocumentListQuerySchema>;

// ---------------------------------------------------------------------------
// Chatbot configuration — `ai:read` / `ai:write`
// ---------------------------------------------------------------------------

/**
 * Why automated replies are or are not happening. Every clause of decision 4's
 * KB-ready rule that fails contributes one entry, so the console can render
 * *why* the bot is off rather than a bare toggle.
 */
export const AI_READINESS_BLOCKERS = [
  /** `ANTHROPIC_API_KEY` is not configured on this deployment. */
  'provider_not_configured',
  'feature_not_in_plan',
  'disabled',
  'no_indexed_documents',
] as const;
export const AiReadinessBlockerSchema = z.enum(AI_READINESS_BLOCKERS);
export type AiReadinessBlocker = (typeof AI_READINESS_BLOCKERS)[number];

export const AiReadinessSchema = z.object({
  ready: z.boolean(),
  indexedDocumentCount: z.int().nonnegative(),
  blockers: z.array(AiReadinessBlockerSchema),
});

export type AiReadiness = z.infer<typeof AiReadinessSchema>;

/** The bounds the database also enforces, named so the console can enforce them too. */
export const AI_CONFIG_LIMITS = {
  systemPromptLength: 4_000,
  handoffMessageLength: 1_000,
  handoffKeywordLength: 64,
  handoffKeywordCount: 50,
  minBotTurns: 1,
  maxBotTurns: 20,
} as const;

/** What a tenant with no `ai_configs` row reads, and what its row is created with. */
export const AI_CONFIG_DEFAULTS = {
  isEnabled: false,
  minConfidence: 0.6,
  maxBotTurns: 5,
} as const;

export const AiConfigResponseSchema = z.object({
  isEnabled: z.boolean(),
  /** Null = the platform default, so a tenant is not pinned to yesterday's model. */
  model: AiModelSchema.nullable(),
  systemPrompt: z.string().max(AI_CONFIG_LIMITS.systemPromptLength).nullable(),
  handoffKeywords: z
    .array(z.string().min(1).max(AI_CONFIG_LIMITS.handoffKeywordLength))
    .max(AI_CONFIG_LIMITS.handoffKeywordCount),
  minConfidence: z.number().min(0).max(1),
  maxBotTurns: z.int().min(AI_CONFIG_LIMITS.minBotTurns).max(AI_CONFIG_LIMITS.maxBotTurns),
  /** Sent to the customer once per conversation on handoff. Null = say nothing. */
  handoffMessage: z.string().max(AI_CONFIG_LIMITS.handoffMessageLength).nullable(),
  readiness: AiReadinessSchema,
  /** So the console can show the cost trade-off where the choice is made. */
  availableModels: z.array(AiModelOptionSchema),
  updatedAt: TimestampSchema,
});

export type AiConfigResponse = z.infer<typeof AiConfigResponseSchema>;

export const UpdateAiConfigInputSchema = AiConfigResponseSchema.pick({
  isEnabled: true,
  model: true,
  systemPrompt: true,
  handoffKeywords: true,
  minConfidence: true,
  maxBotTurns: true,
  handoffMessage: true,
}).partial();

export type UpdateAiConfigInput = z.infer<typeof UpdateAiConfigInputSchema>;

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

export const HandoffConfidenceSchema = z.object({
  /** The composite, 0–1. */
  score: z.number().min(0).max(1),
  modelConfidence: z.number().min(0).max(1),
  retrievalScore: z.number().min(0).max(1),
  modelReason: BotAnswerReasonSchema.nullable(),
});

export type HandoffConfidence = z.infer<typeof HandoffConfidenceSchema>;

/**
 * "Full context" on handoff, as decision 6 defines it (TAR-28 AC2).
 *
 * Two halves, and the first is the important one: **the bot's replies are
 * ordinary `messages` rows**, genuinely sent to the customer over WhatsApp, so
 * the agent's existing thread view already holds the whole exchange verbatim and
 * in order. This DTO carries what the thread cannot — why the bot stopped, how
 * sure it was, and which knowledge-base documents it drew on.
 *
 * `citedDocuments` is the field that earns its place: it is what lets an agent
 * see the bot answered from the *refunds* policy when the customer asked about
 * *shipping*, which is the most common shape of a confident wrong answer and is
 * invisible from the transcript alone.
 */
export const HandoffContextResponseSchema = z.object({
  conversationId: IdSchema,
  ticketId: IdSchema.nullable(),
  reason: HandoffReasonSchema,
  /** The customer message the bot could not handle — the question to answer. */
  triggerMessageId: IdSchema,
  triggerMessageBody: z.string().nullable(),
  /** Every message from `botEngagedAt` to the trigger, inclusive, oldest first. */
  botExchange: z.array(MessageResponseSchema),
  botEngagedAt: TimestampSchema.nullable(),
  handedOffAt: TimestampSchema,
  /** How many times the bot replied before giving up. */
  botReplyCount: z.int().nonnegative(),
  /** Null when the bot never reached the model — `no_match`, `customer_requested`. */
  confidence: HandoffConfidenceSchema.nullable(),
  /** Distinct KB documents cited across the exchange. Empty when it cited none. */
  citedDocuments: z.array(z.object({ id: IdSchema, title: z.string() })),
});

export type HandoffContextResponse = z.infer<typeof HandoffContextResponseSchema>;

/**
 * An agent taking a bot-active thread from the console — one button in the
 * inbox, so the body carries nothing: the reason is always `agent_requested`.
 *
 * **Idempotent by design.** A conversation already `handed_off` or
 * `human_active` answers 200 with the current conversation and writes nothing. A
 * double-click is a no-op, not a `409`.
 */
export const RequestHandoffInputSchema = z.object({}).strict();

export type RequestHandoffInput = z.infer<typeof RequestHandoffInputSchema>;
