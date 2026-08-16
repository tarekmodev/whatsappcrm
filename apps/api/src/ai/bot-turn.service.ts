import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BOT_CONFIDENCE,
  compositeConfidence,
  retrievalConfidence,
  type BotInboundTrigger,
  type BotTurnOutcome,
  type HandoffReason,
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
 * It moves the ticket to `pending`, which pauses the SLA clock. Without that,
 * every conversation the bot handles perfectly still breaches its first-response
 * SLA and pages a supervisor about a customer who already got an answer —
 * `SlaTimerService` stops that timer on an outbound message with a **non-null**
 * sender, and a bot reply has none. `pending` is also semantically honest:
 * after the bot answers, the ticket is waiting on the customer.
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
      await this.prisma.botTurn.updateMany({ where: { id: turnId }, data: scores });

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

    const messageId = await this.prisma.$tenantTransaction(async (tx) => {
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

      await this.pauseSla(tx, trigger.ticketId);

      return replyMessageId;
    });

    await this.sender.dispatch({
      tenantId: trigger.tenantId,
      conversationId: trigger.conversationId,
      contactId: trigger.contactId,
      messageId,
      body,
      sentAt,
    });

    return 'replied';
  }

  /**
   * The conversation goes to a human.
   *
   * The handoff event, the state move and — when the tenant configured one — the
   * customer-facing message all commit together, and the routing request follows
   * the commit.
   *
   * `handoffMessage` is opt-in and null by default, deliberately: a tenant that
   * hands off on every unmatched greeting would otherwise send an apology to
   * every customer who said hello. It is sent once per engagement because
   * `handed_off` is a state the gate refuses to start a second turn from.
   */
  private async handOff(
    trigger: BotInboundTrigger,
    snapshot: BotGateSnapshot,
    reason: HandoffReason,
    turnId: string | null,
  ): Promise<BotTurnOutcome> {
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
   * dragged back into a live state by a reply that raced them.
   */
  private async pauseSla(tx: Prisma.TransactionClient, ticketId: string | null): Promise<void> {
    if (ticketId === null) {
      return;
    }

    await tx.ticket.updateMany({
      where: { id: ticketId, status: TicketStatus.open },
      data: { status: TicketStatus.pending },
    });
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
