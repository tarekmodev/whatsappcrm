import { z } from 'zod';
import { IdSchema, LocaleSchema, TimestampSchema } from './common';
import { MessageResponseSchema } from './messages';
import { CursorPageQuerySchema } from './pagination';

/**
 * The AI chatbot: a tenant's knowledge base, its bot configuration, and the
 * handoff to a human (TAR-28).
 *
 * Published exactly as
 * `docs/architecture/0010-ai-chatbot-knowledge-base-and-handoff.md` specifies it.
 * Two things in that document are load-bearing here and are worth restating
 * where the schemas are, because a reader of this file will not have it open:
 *
 *   1. **The bot answers only when both retrieval and the model agree**
 *      (decision 3), and the composite score is the `min` of the two. The
 *      numbers behind that live in `BOT_CONFIDENCE` below rather than in the
 *      worker, so the console, the worker and the tests read one set.
 *   2. **An empty knowledge base means silence, structurally** (decision 4).
 *      `AiConfigResponse.readiness` is what the console renders instead of a
 *      bare toggle — a tenant whose bot is off deserves to be told *which*
 *      clause is failing, and there are four of them.
 *
 * `ConversationBotState` is declared here rather than in `conversations.ts`
 * because it is this story's vocabulary and `conversations.ts` only carries the
 * field. `MessageOrigin` is **not**, and the asymmetry is deliberate: this file
 * needs `MessageResponseSchema` for `botExchange`, so `messages.ts` owning its
 * own enum is what keeps the dependency one-directional instead of a module
 * cycle.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Where a conversation sits between the bot and a human (0010, decision 5).
 *
 * Four values, not three, and the fourth is the reason this is an enum rather
 * than the existing `botHandling` boolean: "the bot never engaged" and "the bot
 * gave up" are different facts, and an inbox that rendered them identically
 * would make a tenant with no knowledge base look like a tenant whose bot is
 * failing.
 *
 * `human_active` is terminal for the conversation's active life. A bot that
 * resumed answering after an agent had spoken would talk over a colleague in
 * front of the customer, and no confidence score can prevent that.
 */
export const CONVERSATION_BOT_STATES = ['off', 'bot_active', 'handed_off', 'human_active'] as const;
export const ConversationBotStateSchema = z.enum(CONVERSATION_BOT_STATES);
export type ConversationBotState = (typeof CONVERSATION_BOT_STATES)[number];

/** Why the bot stopped and a human is needed (0010, `handoff_events.reason`). */
export const HANDOFF_REASONS = [
  /** The composite score fell below the tenant's threshold. */
  'low_confidence',
  /** Retrieval returned nothing above the floor; the model was never called. */
  'no_match',
  /** A handoff keyword matched the customer's message. */
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

/** The model's own account of the turn, from its forced JSON output. */
export const BOT_ANSWER_REASONS = ['grounded', 'not_in_kb', 'ambiguous', 'wants_human'] as const;
export const BotAnswerReasonSchema = z.enum(BOT_ANSWER_REASONS);
export type BotAnswerReason = (typeof BOT_ANSWER_REASONS)[number];

/** A knowledge document is not retrievable until it has been chunked. */
export const KNOWLEDGE_DOCUMENT_STATUSES = ['pending', 'indexed', 'failed'] as const;
export const KnowledgeDocumentStatusSchema = z.enum(KNOWLEDGE_DOCUMENT_STATUSES);
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];

/**
 * Why automated replies are not happening, one clause per entry (0010,
 * decision 4). All four are checked on every turn; the response carries every
 * one that fails, because fixing one of four and still getting silence is the
 * experience this array exists to prevent.
 */
export const AI_READINESS_BLOCKERS = [
  /** No `ANTHROPIC_API_KEY` on the platform. Nothing a tenant can do. */
  'provider_not_configured',
  /** The tenant's plan does not include `ai_chatbot`. */
  'feature_not_in_plan',
  /** The tenant switched the bot off. */
  'disabled',
  /** The knowledge base is empty, or nothing in it has finished indexing. */
  'no_indexed_documents',
] as const;
export const AiReadinessBlockerSchema = z.enum(AI_READINESS_BLOCKERS);
export type AiReadinessBlocker = (typeof AI_READINESS_BLOCKERS)[number];

// ---------------------------------------------------------------------------
// Models and confidence
// ---------------------------------------------------------------------------

/**
 * The models a tenant may choose, as an allowlist (0010, decision 10).
 *
 * An allowlist rather than free text because an unknown model id is a `404`
 * discovered on a live customer message. `null` on `AiConfigResponse.model`
 * means "whatever the platform's default is today", so a tenant that never
 * chooses is not pinned to whatever was current the day their row was written.
 */
export const AI_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;
export const AiModelSchema = z.enum(AI_MODELS);
export type AiModel = (typeof AI_MODELS)[number];

export const AI_DEFAULT_MODEL: AiModel = 'claude-opus-5';

/**
 * The composite-score constants (0010, decision 3).
 *
 * **Starting values, not measured ones** — stated the way
 * `ASSIGNMENT_POLICY.defaultMaxConcurrentTickets` states its five. They live
 * here so the console, the worker and the tests read one set, and `bot_turns`
 * stores both component scores per turn so re-tuning is a query rather than a
 * research project.
 */
export const BOT_CONFIDENCE = {
  /**
   * The model's declared confidence, mapped to a number. Used only as a
   * **veto**: `score = min(modelConfidence, retrievalConfidence)`, so it can
   * lower the score and can never raise it above what retrieval supports.
   */
  modelConfidenceByLevel: { high: 1.0, medium: 0.6, low: 0.3 },
  /** `retrievalConfidence = clamp(topChunkRank / rankTarget, 0, 1)`. */
  rankTarget: 0.35,
} as const;

/**
 * The bounds `ai_configs` carries as CHECK constraints, named once so the
 * console can enforce them in the form rather than discovering them in a `422`.
 */
export const AI_CONFIG_LIMITS = {
  minConfidenceFloor: 0,
  minConfidenceCeiling: 1,
  /** The seeded default. `0.60` = "at least *medium* from the model, and solid retrieval". */
  defaultMinConfidence: 0.6,
  /** The step an admin adjusts the threshold by, so the control cannot produce 0.6173. */
  minConfidenceStep: 0.05,
  minBotTurns: 1,
  maxBotTurns: 20,
  defaultMaxBotTurns: 5,
  systemPromptMaxLength: 4000,
  handoffMessageMaxLength: 1000,
  handoffKeywordMaxLength: 64,
  maxHandoffKeywords: 50,
} as const;

/**
 * The bounds on a knowledge document, likewise named rather than inlined.
 *
 * Both caps exist so "how large can a knowledge base get" has an answer before a
 * tenant finds one: content over `contentMaxBytes` is `payload_too_large`, and a
 * tenant past `documentsPerTenant` is `conflict`.
 */
export const KNOWLEDGE_DOCUMENT_LIMITS = {
  titleMaxLength: 200,
  /** 256 KiB. */
  contentMaxBytes: 262_144,
  sourceUrlMaxLength: 2048,
  documentsPerTenant: 1000,
} as const;

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export const KnowledgeDocumentResponseSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(KNOWLEDGE_DOCUMENT_LIMITS.titleMaxLength),
  sourceUrl: z.url().nullable(),
  content: z.string(),
  /**
   * Stored for the console and for a future per-language partial index. The
   * retrieval query does **not** consult it: the text search configuration is
   * `'simple'` and cannot be per-tenant (0010, decision 2).
   */
  language: LocaleSchema.nullable(),
  status: KnowledgeDocumentStatusSchema,
  /** Denormalised, so a list can say "indexed, 14 chunks" without a count per row. */
  chunkCount: z.int().nonnegative(),
  /** Why `status` is `failed`. Operator-facing; never rendered to a customer. */
  indexError: z.string().nullable(),
  indexedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const CreateKnowledgeDocumentInputSchema = z.object({
  title: z.string().min(1).max(KNOWLEDGE_DOCUMENT_LIMITS.titleMaxLength),
  content: z.string().min(1).max(KNOWLEDGE_DOCUMENT_LIMITS.contentMaxBytes),
  sourceUrl: z.url().max(KNOWLEDGE_DOCUMENT_LIMITS.sourceUrlMaxLength).optional(),
  language: LocaleSchema.optional(),
});

export const UpdateKnowledgeDocumentInputSchema = CreateKnowledgeDocumentInputSchema.partial();

/**
 * `q` is a plain `ILIKE` over `title` — a console filter, not the retrieval
 * path. The two are deliberately different mechanisms: this one has to find the
 * document an admin is looking for, and retrieval has to refuse when nothing
 * answers the customer.
 */
export const KnowledgeDocumentListQuerySchema = CursorPageQuerySchema.extend({
  status: KnowledgeDocumentStatusSchema.optional(),
  q: z.string().min(1).max(120).optional(),
});

export type KnowledgeDocumentResponse = z.infer<typeof KnowledgeDocumentResponseSchema>;
export type CreateKnowledgeDocumentInput = z.infer<typeof CreateKnowledgeDocumentInputSchema>;
export type UpdateKnowledgeDocumentInput = z.infer<typeof UpdateKnowledgeDocumentInputSchema>;
export type KnowledgeDocumentListQuery = z.infer<typeof KnowledgeDocumentListQuerySchema>;

// ---------------------------------------------------------------------------
// Chatbot configuration
// ---------------------------------------------------------------------------

export const AiReadinessSchema = z.object({
  ready: z.boolean(),
  indexedDocumentCount: z.int().nonnegative(),
  blockers: z.array(AiReadinessBlockerSchema),
});

/**
 * Published so the console can show the cost trade-off where the choice is made
 * rather than hiding a 5× difference behind a dropdown. Prices are **list
 * prices, and the API is their one source** — a console that hard-coded them
 * would be quoting a tenant a number nobody owns.
 */
export const AiModelOptionSchema = z.object({
  id: AiModelSchema,
  displayName: z.string(),
  inputPricePerMTokUsd: z.number(),
  outputPricePerMTokUsd: z.number(),
  isDefault: z.boolean(),
});

export const AiConfigResponseSchema = z.object({
  isEnabled: z.boolean(),
  /** `null` = the platform default, which is what a tenant that never chose gets. */
  model: AiModelSchema.nullable(),
  systemPrompt: z.string().max(AI_CONFIG_LIMITS.systemPromptMaxLength).nullable(),
  handoffKeywords: z
    .array(z.string().min(1).max(AI_CONFIG_LIMITS.handoffKeywordMaxLength))
    .max(AI_CONFIG_LIMITS.maxHandoffKeywords),
  minConfidence: z
    .number()
    .min(AI_CONFIG_LIMITS.minConfidenceFloor)
    .max(AI_CONFIG_LIMITS.minConfidenceCeiling),
  maxBotTurns: z.int().min(AI_CONFIG_LIMITS.minBotTurns).max(AI_CONFIG_LIMITS.maxBotTurns),
  /**
   * Sent to the customer once per conversation on handoff. `null` says nothing,
   * and is the default — a tenant that handed off on every unmatched greeting
   * would otherwise spam.
   */
  handoffMessage: z.string().max(AI_CONFIG_LIMITS.handoffMessageMaxLength).nullable(),
  /** Why automated replies are or are not happening. Drives the console's empty state. */
  readiness: AiReadinessSchema,
  availableModels: z.array(AiModelOptionSchema),
  updatedAt: TimestampSchema,
});

export const UpdateAiConfigInputSchema = AiConfigResponseSchema.pick({
  isEnabled: true,
  model: true,
  systemPrompt: true,
  handoffKeywords: true,
  minConfidence: true,
  maxBotTurns: true,
  handoffMessage: true,
}).partial();

export type AiReadiness = z.infer<typeof AiReadinessSchema>;
export type AiModelOption = z.infer<typeof AiModelOptionSchema>;
export type AiConfigResponse = z.infer<typeof AiConfigResponseSchema>;
export type UpdateAiConfigInput = z.infer<typeof UpdateAiConfigInputSchema>;

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

/**
 * What the human agent is given when the bot lets go (0010, decision 6, and
 * TAR-28's second acceptance criterion).
 *
 * The **thread itself already carries the whole bot exchange**: a bot reply is
 * an ordinary `messages` row, because it was genuinely sent to the customer over
 * WhatsApp. This adds only what the transcript cannot say — why the bot stopped,
 * how sure it was, and which documents it answered from.
 *
 * `botExchange` carries whole `MessageResponse` objects rather than a rendered
 * transcript string, so the console renders them with the component it already
 * uses for the thread and adding a field to a message cannot silently change
 * this endpoint's shape.
 */
export const HandoffContextResponseSchema = z.object({
  conversationId: IdSchema,
  ticketId: IdSchema.nullable(),
  reason: HandoffReasonSchema,
  /** The customer message the bot could not handle. The question to answer. */
  triggerMessageId: IdSchema,
  triggerMessageBody: z.string().nullable(),
  /** Every message from `botEngagedAt` to the trigger, inclusive, oldest first. */
  botExchange: z.array(MessageResponseSchema),
  botEngagedAt: TimestampSchema,
  handedOffAt: TimestampSchema,
  /** How many times the bot replied before giving up. */
  botReplyCount: z.int().nonnegative(),
  /** `null` when the bot never reached the model — `no_match`, `customer_requested`. */
  confidence: z
    .object({
      /** The composite, 0–1. */
      score: z.number(),
      modelConfidence: z.number(),
      retrievalScore: z.number(),
      modelReason: BotAnswerReasonSchema.nullable(),
    })
    .nullable(),
  /**
   * Distinct knowledge-base documents the bot cited across the exchange. Empty
   * when it cited none.
   *
   * The field that earns its place: it is what lets an agent see the bot
   * answered from the *refunds* policy when the customer asked about
   * *shipping* — the most common shape of a confident wrong answer, and one
   * that is invisible from the transcript alone.
   */
  citedDocuments: z.array(z.object({ id: IdSchema, title: z.string() })),
});

/** An agent taking a bot-active thread. The reason is always `agent_requested`. */
export const RequestHandoffInputSchema = z.object({}).strict();

export type HandoffContextResponse = z.infer<typeof HandoffContextResponseSchema>;
export type RequestHandoffInput = z.infer<typeof RequestHandoffInputSchema>;

/**
 * Whether a conversation in this state can still be taken from the bot.
 *
 * `POST /conversations/{id}/handoff` is idempotent by design — a conversation
 * already `handed_off` or `human_active` answers `200` and writes nothing — so
 * this is what decides whether the console *offers* the control, not what makes
 * it safe. A double-click is a no-op, never a `409`.
 */
export function canRequestHandoff(state: ConversationBotState): boolean {
  return state === 'bot_active';
}

/**
 * Whether the bot has been involved at all, and so whether the handoff summary
 * is worth asking for.
 *
 * `off` is the tenant with no bot and the conversation the gate refused
 * silently; both would answer `404`, and a request that can only 404 is one the
 * console should not make.
 */
export function hasBotEngaged(state: ConversationBotState): boolean {
  return state !== 'off';
}
