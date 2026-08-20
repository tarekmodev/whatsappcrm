/**
 * The numbers `AiModule` runs on that are not part of the published contract.
 *
 * Anything a console or a test asserts against lives in
 * `@whatsappcrm/contracts/ai` instead — the confidence constants, the model
 * allowlist, the document caps. What is here is worker and client tuning: the
 * shape of a chunk, the bounds on one model call, and the retry budget of the
 * two jobs. All of them are stated in 0010 and none of them is measured.
 */

/**
 * Jobs this worker processes in parallel.
 *
 * Above the repo default of one, because a turn is dominated by a model call
 * that this process spends waiting rather than working, and the queue is shared
 * by every tenant — one slow provider response would otherwise hold every other
 * tenant's reply behind it. Four keeps the concurrent model calls bounded (the
 * spend and the provider's rate limit are both per-process concerns) while
 * removing the head-of-line block.
 *
 * The indexing job shares the queue and is database-bound and short, so it
 * benefits from the same slot pool. Raise on evidence from TAR-410.
 */
export const AI_WORKER_CONCURRENCY = 4;

/**
 * Attempts a turn gets before it lands in the failed set, and the backoff
 * between them (0010 decision 13).
 *
 * Deliberately small. A `bot_turns` row is inserted before the model call, so a
 * retry that arrives after a successful send is refused by the unique constraint
 * rather than sending twice — but a customer waiting on an answer is not helped
 * by a fifth attempt two minutes later, and the honest fallback is a human.
 */
export const AI_TURN_MAX_ATTEMPTS = 2;
export const AI_TURN_BACKOFF_MS = 2_000;

/** Indexing is idempotent (delete-and-insert in one transaction), so it can afford more. */
export const AI_INDEX_MAX_ATTEMPTS = 3;
export const AI_INDEX_BACKOFF_MS = 2_000;

/**
 * Chunking, per 0010's technology table: paragraph-packed at roughly 1200
 * characters with one paragraph of overlap.
 *
 * A tenant FAQ is authored in paragraphs and headings, so splitting on blank
 * lines respects boundaries the author already chose and needs no tokenizer at
 * write time. A paragraph longer than `hardLimit` on its own is split on
 * whitespace — rare, and better than one chunk that dominates every prompt.
 */
export const CHUNKING = {
  targetChars: 1_200,
  /** A single paragraph longer than this is split rather than kept whole. */
  hardLimit: 2_000,
  /** Paragraphs of overlap carried into the next chunk, for continuity. */
  overlapParagraphs: 1,
} as const;

/**
 * How long one model call may take before the turn becomes `handoff:bot_error`
 * (0010 decision 13).
 *
 * Every outbound call has a timeout; an unbounded wait on a provider becomes an
 * unbounded wait on a worker slot. Twenty seconds sits inside the ten-second
 * p95 target's error budget: the customer waits at most one timeout before a
 * human is engaged.
 */
export const CLAUDE_TIMEOUT_MS = 20_000;

/**
 * `max_tokens` bounds thinking **plus** the answer on this model family, so it
 * is sized with headroom rather than around the reply cap below. A
 * `max_tokens` stop is a handoff, never a partial answer to send.
 */
export const CLAUDE_MAX_TOKENS = 4_096;

/** The longest reply the bot may send a customer, enforced on the model's output. */
export const BOT_REPLY_MAX_CHARS = 1_200;

/** Prior messages put in the prompt, so a follow-up question has its antecedent. */
export const CONVERSATION_HISTORY_TURNS = 6;
