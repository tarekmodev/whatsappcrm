import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BOT_CONFIDENCE,
  SLA_EVALUATE_TICKET_JOB,
  SLA_QUEUE,
  compositeConfidence,
  retrievalConfidence,
  type BotInboundTrigger,
  type BotTurnOutcome,
  type HandoffReason,
  type SlaEvaluateTicketTrigger,
} from '@whatsappcrm/contracts';
import { AutomatedMessageSender } from '../conversations/automated-message.sender';
import type { Prisma } from '../generated/prisma/client';
import {
  ConversationBotState,
  MessageOrigin,
  TicketStatus,
  BotTurnOutcome as StoredBotTurnOutcome,
  HandoffReason as StoredHandoffReason,
} from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { isUniqueViolationOn } from '../prisma/unique-violation';
import { QueueService } from '../queue/queue.service';
import { CONVERSATION_HISTORY_TURNS } from './ai.constants';
import {
  BotEligibilityService,
  decideEligibility,
  type BotGateSnapshot,
  type BotSuppressionReason,
} from './bot-eligibility.service';
import { ClaudeClient, type BotCallResult, type PromptMessage } from './claude.client';
import { HandoffService } from './handoff.service';
import { matchHandoffKeyword } from './handoff-keywords';
import { KnowledgeRetrieverService, type RetrievedChunk } from './knowledge-retriever.service';

/**
 * One inbound message, considered by the bot (0010, `BotTurnService`).
 *
 * The orchestrator: gate → keyword → retrieve → model → score → send-or-handoff.
 * Every branch ends in exactly one of three outcomes recorded on `bot_turns` —
 * `replied`, `handed_off`, `suppressed` — and **there is no path on which the
 * customer is left with silence and no human**, which is the property that
 * matters more here than any latency number.
 *
 * ## The idempotency guard is a row, not a queue property
 *
 * A `bot_turns` row is inserted **before** the model call, claimed on
 * `(tenant_id, inbound_message_id)`. A deterministic BullMQ job id de-duplicates
 * a re-enqueue; it does not de-duplicate a worker that crashed after sending and
 * before acking — and a second WhatsApp message to a customer is visible and
 * unrecoverable.
 *
 * The claim is written **pessimistically**, as `handed_off` / `bot_error`. If
 * this process dies between the claim and the outcome, the row says the turn
 * failed, which is the truth: nothing was sent. The alternative — claiming as
 * `replied` and correcting later — would leave a crash looking like a reply the
 * customer never received.
 *
 * ## What a successful reply also does
 *
 * It moves the ticket to `pending`, which pauses the SLA clock, **and enqueues
 * the evaluation that makes the pause take effect**. Without the status change,
 * every conversation the bot handles perfectly still breaches its first-response
 * SLA and pages a supervisor about a customer who already got an answer —
 * `SlaTimerService` stops that timer on an outbound message with a **non-null**
 * sender, and a bot reply has none. Without the evaluation, the pause lands only
 * when the sweep next reconciles, and the resume arithmetic is wrong in both
 * directions. `pending` is also semantically honest: after the bot answers, the
 * ticket is waiting on the customer.
 */
@Injectable()
export class BotTurnService {
  private readonly logger = new Logger(BotTurnService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly eligibility: BotEligibilityService,
    private readonly retriever: KnowledgeRetrieverService,
    private readonly claude: ClaudeClient,
    private readonly handoffs: HandoffService,
    private readonly sender: AutomatedMessageSender,
    private readonly queue: QueueService,
  ) {}

  async handle(trigger: BotInboundTrigger): Promise<BotTurnOutcome> {
    const now = new Date();
    const snapshot = await this.eligibility.snapshot(trigger, now);
    const decision = decideEligibility(snapshot);

    if (decision.outcome === 'suppress') {
      return this.suppress(trigger, snapshot, decision.reason);
    }

    if (decision.outcome === 'handoff') {
      return this.handOff(trigger, snapshot, decision.reason, null);
    }

    const keyword = matchHandoffKeyword(decision.question, snapshot.settings.handoffKeywords);

    if (keyword !== null) {
      // The cheapest gate and the highest-priority one: a customer asking for a
      // person gets one, without a retrieval query or a token spent.
      this.logger.debug(`Conversation ${trigger.conversationId} handed off on a keyword match.`);

      return this.handOff(trigger, snapshot, 'customer_requested', null);
    }

    const chunks = await this.retriever.retrieve(trigger.tenantId, decision.question);

    if (chunks.length === 0) {
      // Decision 4's second structural rule: with nothing retrieved, no prompt is
      // assembled and no request is sent. This is the code path that makes
      // "a tenant with an empty knowledge base cannot be answered wrongly" a
      // property of the design rather than of the model's behaviour.
      return this.handOff(trigger, snapshot, 'no_match', null);
    }

    const claimed = await this.claimTurn(trigger);

    if (claimed === null) {
      // Another delivery of the same message got there first. Not an error —
      // this is precisely what the unique constraint is for.
      this.logger.debug(`Message ${trigger.messageId} already has a bot turn; skipping.`);

      return 'suppressed';
    }

    const result = await this.claude.answer({
      model: snapshot.settings.model,
      tenantSystemPrompt: snapshot.settings.systemPrompt,
      chunks: chunks.map((chunk) => ({ id: chunk.id, content: chunk.content })),
      history: await this.recentHistory(trigger),
      question: decision.question,
    });

    return this.resolve(trigger, snapshot, chunks, claimed, result);
  }

  /**
   * The scoring gate, and the only place a reply is authorised.
   *
   * Two hard preconditions sit **outside** the score, because they are
   * correctness rather than confidence: every cited id must be one this turn
   * actually retrieved, and there must be at least one. An id the model invented
   * is a fabrication signal, and no score should be able to rescue it.
   */
  private async resolve(
    trigger: BotInboundTrigger,
    snapshot: BotGateSnapshot,
    chunks: readonly RetrievedChunk[],
    turnId: string,
    result: BotCallResult,
  ): Promise<BotTurnOutcome> {
    if (result.outcome === 'failed') {
      await this.prisma.botTurn.updateMany({
        where: { id: turnId },
        data: { error: result.error, latencyMs: result.latencyMs },
      });

      return this.handOff(trigger, snapshot, 'bot_error', turnId);
    }

    const { answer, usage } = result;
    const retrieved = new Set(chunks.map((chunk) => chunk.id));
    const cited = answer.citedChunkIds.filter((id) => retrieved.has(id));
    const grounded = cited.length > 0 && cited.length === answer.citedChunkIds.length;

    const modelConfidence = answer.answered ? BOT_CONFIDENCE.modelConfidence[answer.confidence] : 0;
    const retrievalScore = retrievalConfidence(chunks[0]?.rank ?? 0);
    const score = compositeConfidence(modelConfidence, retrievalScore);

    const scores = {
      score,
      modelConfidence,
      retrievalScore,
      citedChunkIds: cited,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      latencyMs: usage.latencyMs,
    };

    if (!answer.answered || !grounded || answer.answer === null) {
      await this.prisma.botTurn.updateMany({
        where: { id: turnId },
        // `low_confidence` covers the ungrounded case too. A citation the model
        // invented means the answer is not supported by the material, which is
        // what a confidence floor exists to catch — and giving it a reason of
        // its own would put a fabrication label in front of an agent who can do
        // nothing with it.
        data: { ...scores, error: grounded ? null : 'ungrounded_citation' },
      });

      return this.handOff(trigger, snapshot, 'low_confidence', turnId);
    }

    if (score < snapshot.settings.minConfidence) {
      // `error: null` clears the claim placeholder. Every other terminal write
      // already overwrites it; this branch did not, so a turn refused purely on
      // score kept an `error` of 'claimed' and read as a failure that never
      // happened.
      await this.prisma.botTurn.updateMany({
        where: { id: turnId },
        data: { ...scores, error: null },
      });

      return this.handOff(trigger, snapshot, 'low_confidence', turnId);
    }

    return this.reply(trigger, snapshot, turnId, answer.answer, scores);
  }

  /**
   * The customer gets an answer.
   *
   * One transaction: the message, the turn's outcome, the conversation's state,
   * and the ticket's pause. They commit together because a reply the customer
   * received with no `bot_turns` row to prove it would let a retry send it
   * again, and a conversation left `off` after a reply would let the next
   * message start the turn count from zero.
   */
  private async reply(
    trigger: BotInboundTrigger,
    snapshot: BotGateSnapshot,
    turnId: string,
    body: string,
    scores: TurnScores,
  ): Promise<BotTurnOutcome> {
    const sentAt = new Date();

    const committed = await this.prisma.$tenantTransaction(async (tx) => {
      const replyMessageId = await this.sender.writeOutboundText(tx, {
        tenantId: trigger.tenantId,
        conversationId: trigger.conversationId,
        body,
        origin: MessageOrigin.bot,
        sentAt,
      });

      await tx.botTurn.updateMany({
        where: { id: turnId },
        data: {
          ...scores,
          outcome: StoredBotTurnOutcome.replied,
          handoffReason: null,
          replyMessageId,
          error: null,
        },
      });

      // Compare-and-set: an agent can claim the thread while the model is
      // thinking, and `human_active` is terminal. Losing this race means the
      // reply still went out — it was already authorised — but the bot does not
      // take the conversation back.
      await tx.conversation.updateMany({
        where: {
          id: trigger.conversationId,
          botState: { not: ConversationBotState.human_active },
        },
        data: {
          botState: ConversationBotState.bot_active,
          // Set once, on the first engagement: it is the start of the window the
          // handoff DTO's `botExchange` spans, and moving it on every reply would
          // shorten that window to the last exchange.
          ...(snapshot.conversation?.botEngagedAt === null ? { botEngagedAt: sentAt } : {}),
        },
      });

      const paused = await this.pauseSla(tx, trigger.ticketId);

      return { replyMessageId, paused };
    });

    await this.sender.dispatch({
      tenantId: trigger.tenantId,
      conversationId: trigger.conversationId,
      contactId: trigger.contactId,
      messageId: committed.replyMessageId,
      body,
      sentAt,
    });

    // After the commit, never inside it: an evaluation job that overtook its own
    // transaction would read a ticket that is still `open` and pause nothing.
    // Only when the status actually moved — a ticket an agent had already
    // resolved has no pause to record.
    if (committed.paused && trigger.ticketId !== null) {
      await this.queueSlaEvaluation(trigger.tenantId, trigger.ticketId);
    }

    return 'replied';
  }

  /**
   * The conversation goes to a human.
   *
   * The handoff event, the state move and — when the tenant configured one — the
   * customer-facing message all commit together, and the routing request follows
   * the commit.
   *
   * **Not every refusal reaches here.** A `no_match` or `low_confidence` refusal
   * on a conversation the bot has never spoken in is not a handoff at all — see
   * `suppressUnanswered`, which the guard below routes it to. That is also what
   * keeps `handoffMessage` at most once per conversation: the apology is never
   * sent to a greeting, and after a real handoff `handed_off` is a state the
   * gate refuses to start a second turn from.
   *
   * `handoffMessage` stays opt-in and null by default regardless — a tenant may
   * still prefer their customers hear nothing rather than an apology.
   */
  private async handOff(
    trigger: BotInboundTrigger,
    snapshot: BotGateSnapshot,
    reason: HandoffReason,
    turnId: string | null,
  ): Promise<BotTurnOutcome> {
    if (SUPPRESSED_WHEN_UNENGAGED.has(reason) && hasNeverEngaged(snapshot)) {
      return this.suppressUnanswered(trigger, snapshot, reason, turnId);
    }

    const sentAt = new Date();
    const message = snapshot.settings.handoffMessage;
    const botEngagedAt = snapshot.conversation?.botEngagedAt ?? null;

    const messageId = await this.prisma.$tenantTransaction(async (tx) => {
      if (turnId !== null) {
        await tx.botTurn.updateMany({
          where: { id: turnId },
          data: {
            outcome: StoredBotTurnOutcome.handed_off,
            handoffReason: reason,
          },
        });
      }

      await this.handoffs.record(tx, {
        tenantId: trigger.tenantId,
        conversationId: trigger.conversationId,
        ticketId: trigger.ticketId,
        reason,
        triggerMessageId: trigger.messageId,
        botTurnId: turnId,
        botEngagedAt,
        botReplyCount: snapshot.botReplyCount,
      });

      if (message === null || message.trim() === '') {
        return null;
      }

      return this.sender.writeOutboundText(tx, {
        tenantId: trigger.tenantId,
        conversationId: trigger.conversationId,
        body: message,
        // `bot`, not `system`: the customer is being spoken to by the same
        // automation that has been answering them, and the console badges it the
        // same way.
        origin: MessageOrigin.bot,
        sentAt,
      });
    });

    if (messageId !== null) {
      await this.sender.dispatch({
        tenantId: trigger.tenantId,
        conversationId: trigger.conversationId,
        contactId: trigger.contactId,
        messageId,
        body: message ?? '',
        sentAt,
      });
    }

    await this.handoffs.requestRoutingIfUnowned(trigger.ticketId, trigger.contactId);

    return 'handed_off';
  }

  /**
   * The bot had nothing to say, and had never said anything (0010 decision 5,
   * as narrowed by the Architect on TAR-406).
   *
   * Decision 5 put two different facts in one state: **a human has been asked
   * for**, and **the bot could not help**. Only the first should be terminal.
   * An opening "hi" that misses the knowledge base is the second, and treating
   * it as the first disabled the bot for the rest of the conversation — so the
   * real question, arriving one message later, was never eligible to be
   * answered. That made TAR-28 AC1 unreachable through the most ordinary opener
   * there is.
   *
   * So this path records the refusal and stops: **no handoff event, no
   * `handoffMessage`, no `bot_state` move, no routing re-request.** The
   * conversation stays `off`, which is the truth — the bot is not and has never
   * been in charge of it — and the next message is gated afresh.
   *
   * Nobody is stranded by the silence, because the handoff was never what got a
   * human involved: the ticket exists and routing already ran on ticket
   * creation (decision 8), and the SLA clock is still running because only a
   * *successful reply* pauses it (decision 7). An unanswerable opening question
   * is a live, routed, clocked ticket, with the breach sweep as the backstop.
   *
   * The two call sites differ only in whether the claim row exists yet, and the
   * difference is not cosmetic: `suppress()` inserts, so calling it after the
   * claim would hit the `inbound_message_id` unique constraint and throw on a
   * path whose whole purpose is to do nothing.
   */
  private async suppressUnanswered(
    trigger: BotInboundTrigger,
    snapshot: BotGateSnapshot,
    reason: HandoffReason,
    turnId: string | null,
  ): Promise<BotTurnOutcome> {
    if (turnId === null) {
      return this.suppress(trigger, snapshot, UNENGAGED_SUPPRESSION);
    }

    await this.prisma.botTurn.updateMany({
      where: { id: turnId },
      data: {
        outcome: StoredBotTurnOutcome.suppressed,
        // **Nulled, and it has to be.** `bot_turns_handoff_reason_matches_outcome`
        // is a biconditional — `(outcome = 'handed_off') = (handoff_reason IS NOT
        // NULL)` — so a suppressed row carrying a reason is rejected by the
        // database, and the claim wrote `bot_error` here. Leaving it would throw a
        // check violation on the one path whose entire purpose is to do nothing.
        //
        // The reason still survives, in `error`, which is where `suppress()`
        // already records why a suppressed turn was suppressed. What that costs is
        // the `ungrounded_citation` marker on the narrow overlap of "cited
        // something it never retrieved" and "had never spoken" — the scores and
        // token counts are still on the row, so the model was demonstrably called.
        handoffReason: null,
        error: UNENGAGED_SUPPRESSION,
      },
    });

    this.logger.debug(
      `Bot turn for message ${trigger.messageId} suppressed ` +
        `(${UNENGAGED_SUPPRESSION}, ${reason}); conversation ${trigger.conversationId} ` +
        `stays eligible for the message that follows.`,
    );

    return 'suppressed';
  }

  /**
   * A turn the customer never sees.
   *
   * **Tenant-level refusals write nothing.** A tenant with no plan, no key or no
   * knowledge base would otherwise get one `bot_turns` row per inbound message
   * across the whole platform — doubling the write volume of the busiest table
   * in the product to record a constant that `GET /ai/config` already publishes
   * as a readiness blocker.
   *
   * Conversation-level refusals do write one: they are rare, they are facts
   * about *this* thread rather than about the tenant, and they are what an
   * operator asks about when a bot that is switched on did not answer.
   */
  private async suppress(
    trigger: BotInboundTrigger,
    snapshot: BotGateSnapshot,
    reason: BotSuppressionReason,
  ): Promise<BotTurnOutcome> {
    if (TENANT_LEVEL_SUPPRESSIONS.has(reason)) {
      return 'suppressed';
    }

    await this.prisma.botTurn
      .create({
        data: {
          tenantId: trigger.tenantId,
          conversationId: trigger.conversationId,
          inboundMessageId: trigger.messageId,
          outcome: StoredBotTurnOutcome.suppressed,
          error: reason,
        },
        select: { id: true },
      })
      .catch((error: unknown) => {
        if (isUniqueViolationOn(error, 'inbound_message_id')) {
          // A redelivery of a message already considered. The constraint is
          // doing its job; there is nothing to repair.
          return;
        }

        throw error;
      });

    this.logger.debug(
      `Bot turn for message ${trigger.messageId} suppressed (${reason}); ` +
        `conversation ${trigger.conversationId} is unchanged.`,
    );

    return 'suppressed';
  }

  /**
   * Claims this message for exactly one turn, or reports that another delivery
   * already holds it.
   *
   * `snapshot.botReplyCount` is not re-read here and does not need to be: the
   * cap is a gate on starting a turn, and this claim is what makes two
   * concurrent turns on one message impossible.
   */
  private async claimTurn(trigger: BotInboundTrigger): Promise<string | null> {
    try {
      const { id } = await this.prisma.botTurn.create({
        data: {
          tenantId: trigger.tenantId,
          conversationId: trigger.conversationId,
          inboundMessageId: trigger.messageId,
          // The pessimistic claim — corrected the moment the turn resolves. A
          // crash in between leaves the honest record: nothing was sent.
          outcome: StoredBotTurnOutcome.handed_off,
          handoffReason: StoredHandoffReason.bot_error,
          error: 'claimed',
        },
        select: { id: true },
      });

      return id;
    } catch (error: unknown) {
      if (isUniqueViolationOn(error, 'inbound_message_id')) {
        return null;
      }

      throw error;
    }
  }

  /**
   * A bot reply moves the ticket to `pending`, which the existing SLA machinery
   * reads as a pause — no new SLA code at all (0010 decision 7).
   *
   * The status write is system-initiated with a null actor, which has precedent:
   * `TicketLinkerService`'s reopen already writes a status with no actor and
   * deliberately emits no `ticket.updated`.
   *
   * `updateMany` guarded on `open`, so a ticket an agent already resolved is not
   * dragged back into a live state by a reply that raced them — and reporting
   * *whether* it moved is what lets the caller enqueue an evaluation only for a
   * status change that actually happened.
   */
  private async pauseSla(tx: Prisma.TransactionClient, ticketId: string | null): Promise<boolean> {
    if (ticketId === null) {
      return false;
    }

    const { count } = await tx.ticket.updateMany({
      where: { id: ticketId, status: TicketStatus.open },
      data: { status: TicketStatus.pending },
    });

    return count > 0;
  }

  /**
   * Tells the SLA module the ticket's status changed (0006's `status_changed`
   * trigger), after the transaction that changed it has committed.
   *
   * ## Why the status write alone is not enough
   *
   * `TICKET_STATUS_PAUSES_SLA` makes `pending` a paused state, but nothing reads
   * that column until something evaluates the ticket. Without this enqueue the
   * pause lands only when the breach sweep next reconciles, and the arithmetic
   * is wrong in both directions on resume: a customer who replies after `due_at`
   * gets a zero-budget breach, and one who replies before it has the whole bot
   * exchange charged to the human's first-response window. That is the condition
   * 0006's owner attached to signing off decision 7, and this is the one call
   * site it asked for.
   *
   * The same shape `MessageSendService.queueSlaEvaluation` uses, deliberately:
   *
   *   * **No custom `jobId`.** A ticket-keyed id collapses every later trigger
   *     into the completed key of the one before it — the bug that made a reply
   *     silently fail to stop a clock. The handler is a reconciler, so an id
   *     buys nothing.
   *   * **Retried**, because the status is durable and the evaluation is owed: a
   *     job that overtook its own transaction succeeds on the next attempt.
   *   * **A queue name, not an import.** `SlaModule` is L4 and so is this one;
   *     what crosses is the shape in `@whatsappcrm/contracts/sla`.
   *
   * Never throws, per `QueueService`'s contract. The reply has already gone to
   * the customer and the ticket is already `pending`; a Redis blip must not turn
   * that into a failed turn, and the sweep still reconciles it late — which is
   * the pre-fix behaviour, now the degraded path rather than the normal one.
   */
  private async queueSlaEvaluation(tenantId: string, ticketId: string): Promise<void> {
    const trigger: SlaEvaluateTicketTrigger = { tenantId, ticketId, reason: 'status_changed' };

    const outcome = await this.queue.enqueue<SlaEvaluateTicketTrigger>(
      SLA_QUEUE,
      SLA_EVALUATE_TICKET_JOB,
      trigger,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Ticket ${ticketId} was paused by a bot reply but its SLA evaluation was not queued ` +
          `(${outcome}); the clock will not pause until the sweep reconciles it.`,
      );
    }
  }

  /**
   * The last few messages of the thread, oldest first, so a follow-up question
   * has its antecedent.
   *
   * Bounded and small: the prompt's job is to ground an answer in the knowledge
   * base, not to re-litigate the conversation, and every extra turn is input
   * tokens on a path that runs per customer message.
   */
  private async recentHistory(trigger: BotInboundTrigger): Promise<PromptMessage[]> {
    const messages = await this.prisma.message.findMany({
      where: {
        conversationId: trigger.conversationId,
        // The triggering message is the question, and it is put in the prompt
        // separately — including it here would ask it twice.
        NOT: { id: trigger.messageId },
        body: { not: null },
      },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: CONVERSATION_HISTORY_TURNS,
      select: { direction: true, body: true },
    });

    return messages.reverse().map((message) => ({
      role: message.direction === 'inbound' ? ('customer' as const) : ('business' as const),
      body: message.body ?? '',
    }));
  }
}

/** What `bot_turns` records about a scored turn. */
interface TurnScores {
  readonly score: number;
  readonly modelConfidence: number;
  readonly retrievalScore: number;
  /** Mutable, because Prisma's generated array-update input is. */
  readonly citedChunkIds: string[];
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly latencyMs: number;
}

/**
 * The reason written on a turn that becomes a suppression because the bot had
 * never spoken. Deliberately **absent** from `TENANT_LEVEL_SUPPRESSIONS`: it is
 * a fact about one thread, not about the tenant, and it is the row an operator
 * asks about when a bot that is switched on said nothing.
 */
const UNENGAGED_SUPPRESSION: BotSuppressionReason = 'no_answer_unengaged';

/**
 * Handoff reasons that mean *the bot could not help*, which stop being terminal
 * when the bot has never spoken in the conversation.
 *
 * The three reasons deliberately left out stay terminal at zero engagement:
 *
 *   * `customer_requested` — the customer asked for a person. The one thing the
 *     bot must never talk its way out of.
 *   * `bot_error` — a provider incident fails toward a human, per 0010's own
 *     failure table.
 *   * `max_turns` — unreachable with no replies, and listed so that stays a
 *     decision rather than an accident of the arithmetic.
 *
 * `low_confidence` has to be here or the defect survives by a second door: a
 * greeting that clears the trigram floor reaches the model, comes back
 * `answered: false`, and lands in the same terminal state that `no_match` used
 * to.
 */
const SUPPRESSED_WHEN_UNENGAGED = new Set<HandoffReason>(['no_match', 'low_confidence']);

/**
 * Has the bot ever spoken in this conversation?
 *
 * Both columns, not either: `bot_engaged_at` is stamped in the same transaction
 * as the first reply and `bot_reply_count` counts replied turns, so they agree —
 * and reading both means a future path that moves one without the other cannot
 * quietly re-open a terminal handoff. `handoff_events` already carries the pair,
 * which is the tell that "was the bot actually engaged" was always the
 * load-bearing distinction.
 */
function hasNeverEngaged(snapshot: BotGateSnapshot): boolean {
  return (snapshot.conversation?.botEngagedAt ?? null) === null && snapshot.botReplyCount === 0;
}

/**
 * Refusals that are true of the tenant rather than of this conversation, and are
 * therefore not worth a row per inbound message. See `suppress`.
 */
const TENANT_LEVEL_SUPPRESSIONS = new Set<BotSuppressionReason>([
  'provider_not_configured',
  'feature_not_in_plan',
  'disabled',
  'no_knowledge_base',
  'not_inbound',
  'unreadable',
]);
