import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ASSIGNMENT_QUEUE,
  ASSIGNMENT_ROUTE_JOB,
  assignmentRouteJobId,
  type ConversationResponse,
  type HandoffContextResponse,
  type HandoffReason,
  type TicketRoutingTrigger,
} from '@whatsappcrm/contracts';
import { ResponseOriginService } from '../common/response-origin.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { ConversationQueryService } from '../conversations/conversation-query.service';
import { toConversationResponse } from '../conversations/conversation.mapper';
import { MESSAGE_PROJECTION, toMessageResponse } from '../conversations/message.mapper';
import type { Prisma } from '../generated/prisma/client';
import { ConversationBotState } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { QueueService } from '../queue/queue.service';
import { HandoffNotFoundError } from './ai.errors';
import { countRepliesThisEngagement } from './engagement-replies';

/**
 * Releasing a conversation to a human, and telling that human what happened
 * (0010 decision 6, TAR-28 AC2).
 *
 * ## What "full context" actually is
 *
 * Two halves, and the first is the important one: **the bot's replies are
 * ordinary `messages` rows.** They were genuinely sent to the customer over
 * WhatsApp, so they must be — anything else would give the agent a thread that
 * does not match what the customer sees. The agent's existing thread view
 * therefore already contains the entire bot exchange, verbatim and in order,
 * with no new UI required.
 *
 * On top of that, `GET /conversations/{id}/handoff` returns the summary the
 * thread cannot carry: why the bot stopped, how sure it was, and which
 * knowledge-base documents it drew on.
 *
 * ## Routing is re-requested only when nobody holds the ticket
 *
 * 0007's pipeline is untouched: routing fires on ticket creation and may have
 * placed the ticket with an agent before the bot said anything, which is what
 * makes a handoff instant rather than the start of a wait. A handoff re-requests
 * routing **only** when `routing_state` is `pending` or `deferred` — never for
 * `assigned` or `manual`, which would step over 0007's rule that a human
 * placement is terminal.
 */
@Injectable()
export class HandoffService {
  private readonly logger = new Logger(HandoffService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly conversations: ConversationQueryService,
    private readonly origin: ResponseOriginService,
    private readonly queue: QueueService,
  ) {}

  /**
   * Records the handoff and moves the conversation, inside the caller's
   * transaction.
   *
   * The event row and the state move commit together on purpose: a
   * `handoff_events` row with the conversation still `bot_active` would let the
   * next inbound message start another turn on a thread that has already been
   * given away.
   *
   * The compare-and-set on `bot_state <> 'human_active'` is what closes the
   * window between the gate and this write — an agent can claim the thread while
   * the model is thinking, and the bot must not take it back.
   */
  async record(tx: Prisma.TransactionClient, handoff: HandoffRecord): Promise<void> {
    await tx.handoffEvent.create({
      data: {
        tenantId: handoff.tenantId,
        conversationId: handoff.conversationId,
        ticketId: handoff.ticketId,
        // No cast: `HANDOFF_REASONS` in the contract and the `handoff_reason`
        // enum in the schema are the same six values, so the compiler checks
        // them against each other. If one of them ever gains a value the other
        // lacks, this line is where it fails.
        reason: handoff.reason,
        triggerMessageId: handoff.triggerMessageId,
        botTurnId: handoff.botTurnId,
        botEngagedAt: handoff.botEngagedAt,
        botReplyCount: handoff.botReplyCount,
      },
      select: { id: true },
    });

    await tx.conversation.updateMany({
      where: {
        id: handoff.conversationId,
        botState: { not: ConversationBotState.human_active },
      },
      data: { botState: ConversationBotState.handed_off },
    });
  }

  /**
   * `POST /api/v1/conversations/{id}/handoff` — an agent taking a bot-active
   * thread from the console.
   *
   * **Idempotent by design.** A conversation already `handed_off` or
   * `human_active` answers 200 with the current resource and writes nothing: a
   * double-clicked button is a no-op, not a `409`. A conversation the bot never
   * touched is the same no-op, for the same reason — there is nothing to take.
   *
   * `conversation:claim` plus the module's ordinary visibility check, so a
   * thread the principal may not see answers `not_found` before anything is
   * written.
   */
  async requestFromAgent(conversationId: string): Promise<ConversationResponse> {
    const tenantId = this.tenantContext.requireTenantId();
    const conversation = await this.conversations.require(conversationId);

    const state = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { botState: true, botEngagedAt: true },
    });

    if (state.botState !== ConversationBotState.bot_active) {
      return toConversationResponse(conversation);
    }

    const trigger = await this.prisma.message.findFirst({
      where: { conversationId, direction: 'inbound' },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });

    if (trigger === null) {
      // A bot-active conversation with no inbound message cannot exist through
      // any path this codebase has — the turn is triggered *by* an inbound
      // message. Reported rather than forced, because `handoff_events`
      // deliberately requires a trigger message and inventing one would put a
      // lie in the audit trail.
      this.logger.warn(
        `Conversation ${conversationId} is bot-active with no inbound message; nothing to hand off.`,
      );

      return toConversationResponse(conversation);
    }

    const ticketId = await this.activeTicketId(conversationId);

    // Scoped to this engagement, and the same helper the gate uses. The pair
    // written below has to describe one span of time: `bot_engaged_at` already
    // did, and a lifetime count beside it made the console's handoff card
    // contradict itself — "5 replies" above a transcript holding two, because
    // the three from a conversation resolved in June were still in `bot_turns`.
    // The check constraint cannot catch that; it only asks the count to be zero
    // when there is no stamp.
    const botReplyCount = await countRepliesThisEngagement(
      this.prisma,
      conversationId,
      state.botEngagedAt,
    );

    await this.prisma.$tenantTransaction(async (tx) => {
      await this.record(tx, {
        tenantId,
        conversationId,
        ticketId,
        reason: 'agent_requested',
        triggerMessageId: trigger.id,
        botTurnId: null,
        botEngagedAt: state.botEngagedAt,
        botReplyCount,
      });
    });

    // Deliberately no routing re-request. An agent pressing this button *is* the
    // human taking the thread; asking the router to find one would be a race
    // against the person who already decided.
    return toConversationResponse(await this.conversations.require(conversationId));
  }

  /**
   * `GET /api/v1/conversations/{id}/handoff` — the most recent handoff, or
   * `not_found`.
   *
   * Not unique per conversation: a thread can be resolved, reopened by a later
   * question, handled by the bot again and handed off again. The newest row is
   * the one an agent is looking at.
   */
  async context(conversationId: string): Promise<HandoffContextResponse> {
    // The visibility check first, so a conversation the principal may not see
    // answers `not_found` for the same reason one with no handoff does.
    await this.conversations.require(conversationId);

    const event = await this.prisma.handoffEvent.findFirst({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: HANDOFF_PROJECTION,
    });

    if (event === null) {
      throw new HandoffNotFoundError(conversationId);
    }

    const botExchange = await this.botExchange(conversationId, event.botEngagedAt, event.createdAt);
    const citedDocuments = await this.citedDocuments(conversationId, event.botEngagedAt);

    return {
      conversationId,
      ticketId: event.ticketId,
      reason: event.reason,
      triggerMessageId: event.triggerMessageId,
      triggerMessageBody: event.triggerMessage.body,
      botExchange,
      botEngagedAt: event.botEngagedAt?.toISOString() ?? null,
      handedOffAt: event.createdAt.toISOString(),
      botReplyCount: event.botReplyCount,
      confidence:
        event.botTurn === null || event.botTurn.score === null
          ? null
          : {
              score: event.botTurn.score.toNumber(),
              modelConfidence: event.botTurn.modelConfidence?.toNumber() ?? 0,
              retrievalScore: event.botTurn.retrievalScore?.toNumber() ?? 0,
              modelReason: null,
            },
      citedDocuments,
    };
  }

  /**
   * Every message from the moment the bot engaged to the handoff, oldest first.
   *
   * Whole `MessageResponse` objects rather than a rendered transcript string,
   * per 0002's rule that payloads are whole resources: the console renders them
   * with the same component it already uses for the thread, and adding a field
   * to a message cannot silently change this endpoint's shape.
   *
   * A handoff where the bot never replied has no window to span, and the
   * exchange is empty — the agent has the ordinary thread and the trigger
   * message, which is all there was.
   */
  private async botExchange(
    conversationId: string,
    botEngagedAt: Date | null,
    handedOffAt: Date,
  ): Promise<HandoffContextResponse['botExchange']> {
    if (botEngagedAt === null) {
      return [];
    }

    const messages = await this.prisma.message.findMany({
      where: { conversationId, sentAt: { gte: botEngagedAt, lte: handedOffAt } },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      // Bounded, like every list in this codebase. `maxBotTurns` caps a
      // conversation at 20 bot replies, so a window this size is a wide margin
      // rather than a truncation anyone will meet.
      take: BOT_EXCHANGE_MAX_MESSAGES,
      select: MESSAGE_PROJECTION,
    });

    const requestOrigin = this.origin.require();

    return messages.map((message) => toMessageResponse(message, requestOrigin));
  }

  /**
   * The distinct knowledge-base documents the bot cited across the exchange.
   *
   * The field that earns its place in review: it is what lets an agent see the
   * bot answered from the *refunds* policy when the customer was asking about
   * *shipping* — the most common shape of a confident wrong answer, and one that
   * is invisible from the transcript alone.
   *
   * Two indexed reads rather than a join, because `cited_chunk_ids` is a plain
   * array column: the turns for this conversation, then the documents those
   * chunks belong to. Both are bounded by the same turn cap.
   */
  private async citedDocuments(
    conversationId: string,
    botEngagedAt: Date | null,
  ): Promise<HandoffContextResponse['citedDocuments']> {
    if (botEngagedAt === null) {
      return [];
    }

    const turns = await this.prisma.botTurn.findMany({
      where: { conversationId, createdAt: { gte: botEngagedAt } },
      select: { citedChunkIds: true },
    });

    const chunkIds = [...new Set(turns.flatMap((turn) => turn.citedChunkIds))];

    if (chunkIds.length === 0) {
      return [];
    }

    const chunks = await this.prisma.knowledgeChunk.findMany({
      where: { id: { in: chunkIds } },
      select: { document: { select: { id: true, title: true } } },
    });

    const byId = new Map(chunks.map(({ document }) => [document.id, document.title]));

    return [...byId].map(([id, title]) => ({ id, title }));
  }

  /** The thread's live ticket, which the handoff row records and routing needs. */
  private async activeTicketId(conversationId: string): Promise<string | null> {
    const ticket = await this.prisma.ticket.findFirst({
      where: { conversationId, status: { in: ['open', 'pending'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });

    return ticket?.id ?? null;
  }

  /**
   * Asks the router for an owner, but **only when nobody holds the ticket**.
   *
   * Called after the handoff transaction commits, never inside it: a routing job
   * that overtook its own commit would read a conversation the bot still owned.
   *
   * `enqueue` reports rather than throws, per `QueueService`'s contract — a
   * Redis outage leaves the conversation handed off and unassigned, which is
   * exactly the state a thread nobody has claimed is already in, rather than
   * failing a turn whose message has already gone to the customer.
   */
  async requestRoutingIfUnowned(ticketId: string | null, contactId: string): Promise<void> {
    if (ticketId === null) {
      return;
    }

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, routingState: true, createdAt: true },
    });

    if (
      ticket === null ||
      (ticket.routingState !== 'pending' && ticket.routingState !== 'deferred')
    ) {
      return;
    }

    const routing: TicketRoutingTrigger = {
      tenantId: this.tenantContext.requireTenantId(),
      ticketId: ticket.id,
      contactId,
      // No message: a handoff is not a keyword condition's subject, and pointing
      // a `keyword` rule at the message the bot could not answer would route on
      // text the rule was never written for.
      messageId: null,
      createdAt: ticket.createdAt.toISOString(),
    };

    const outcome = await this.queue.enqueue(ASSIGNMENT_QUEUE, ASSIGNMENT_ROUTE_JOB, routing, {
      jobId: assignmentRouteJobId(routing),
    });

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Ticket ${ticket.id} was handed off but not queued for routing (${outcome}): ` +
          'it stays unassigned until a routing job runs for it.',
      );
    }
  }
}

/** What `record` needs, and nothing the caller would have to look up twice. */
export interface HandoffRecord {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly ticketId: string | null;
  readonly reason: HandoffReason;
  readonly triggerMessageId: string;
  /** Null for `customer_requested` and `no_match` — the model was never called. */
  readonly botTurnId: string | null;
  readonly botEngagedAt: Date | null;
  readonly botReplyCount: number;
}

const HANDOFF_PROJECTION = {
  ticketId: true,
  reason: true,
  triggerMessageId: true,
  botEngagedAt: true,
  botReplyCount: true,
  createdAt: true,
  triggerMessage: { select: { body: true } },
  botTurn: { select: { score: true, modelConfidence: true, retrievalScore: true } },
} as const satisfies Prisma.HandoffEventSelect;

/** A hard bound on the exchange window, so no response is unbounded. */
const BOT_EXCHANGE_MAX_MESSAGES = 100;
