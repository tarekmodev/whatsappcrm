import {
  AI_CONFIG_DEFAULTS,
  BOT_CONFIDENCE,
  SLA_EVALUATE_TICKET_JOB,
  SLA_QUEUE,
} from '@whatsappcrm/contracts';
import type { BotInboundTrigger } from '@whatsappcrm/contracts';
import type { AutomatedMessageSender } from '../conversations/automated-message.sender';
import { Prisma } from '../generated/prisma/client';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { QueueService } from '../queue/queue.service';
import type { AiSettings } from './ai-config.service';
import type { BotEligibilityService, BotGateSnapshot } from './bot-eligibility.service';
import { BotTurnService } from './bot-turn.service';
import type { BotCallResult, ClaudeClient } from './claude.client';
import type { HandoffService } from './handoff.service';
import type { KnowledgeRetrieverService, RetrievedChunk } from './knowledge-retriever.service';

/**
 * The confidence gate and the handoff logic — TAR-28's first two acceptance
 * criteria, and the two rules 0010 says must be testable with a stubbed model
 * client:
 *
 * > Given a customer asks a question matched in the tenant's knowledge base,
 * > when the bot is confident, then it replies automatically.
 * >
 * > Given the bot is not confident, or the customer asks to speak to a human,
 * > then the conversation hands off to a human agent with full context.
 *
 * The model is a fake here on purpose. What is under test is the decision — the
 * `min` of two signals, the citation precondition, and the fact that **every**
 * refusal ends with a human rather than with silence. A design whose central
 * rule could only be tested against a live API is one that would not be tested.
 */

const TENANT = '70444444-4444-7444-8444-444444444401';
const CONVERSATION = '70444444-4444-7444-8444-4444444444c1';
const CONTACT = '70444444-4444-7444-8444-4444444444d1';
const MESSAGE = '70444444-4444-7444-8444-4444444444e0';
const TICKET = '70444444-4444-7444-8444-4444444444c9';
const TURN = '70444444-4444-7444-8444-4444444444f0';
const CHUNK = '70444444-4444-7444-8444-4444444444b1';
const REPLY = '70444444-4444-7444-8444-4444444444b9';

const TRIGGER: BotInboundTrigger = {
  tenantId: TENANT,
  conversationId: CONVERSATION,
  contactId: CONTACT,
  messageId: MESSAGE,
  ticketId: TICKET,
  receivedAt: '2026-08-16T10:00:00.000Z',
};

/** A rank at the target, so retrieval contributes a full 1.0 to the score. */
const STRONG_CHUNK: RetrievedChunk = {
  id: CHUNK,
  documentId: '70444444-4444-7444-8444-4444444444a1',
  documentTitle: 'Refund policy',
  ordinal: 0,
  content: 'Refunds are issued within 5 working days.',
  rank: BOT_CONFIDENCE.rankTarget,
};

/** Just above the floor, so retrieval alone cannot carry a turn. */
const WEAK_CHUNK: RetrievedChunk = { ...STRONG_CHUNK, rank: BOT_CONFIDENCE.rankFloor };

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    isEnabled: true,
    model: null,
    systemPrompt: null,
    handoffKeywords: ['agent'],
    minConfidence: AI_CONFIG_DEFAULTS.minConfidence,
    maxBotTurns: AI_CONFIG_DEFAULTS.maxBotTurns,
    handoffMessage: null,
    ...overrides,
  };
}

function answered(
  overrides: Partial<{
    confidence: 'high' | 'medium' | 'low';
    citedChunkIds: string[];
    answered: boolean;
  }> = {},
): BotCallResult {
  return {
    outcome: 'answered',
    answer: {
      answered: true,
      answer: 'Refunds take five working days.',
      confidence: 'high',
      citedChunkIds: [CHUNK],
      reason: 'grounded',
      ...overrides,
    },
    usage: {
      model: 'claude-opus-5',
      latencyMs: 1_200,
      inputTokens: 2_600,
      outputTokens: 120,
      cachedInputTokens: 2_000,
    },
  };
}

describe('BotTurnService', () => {
  let service: BotTurnService;
  let snapshotSettings: AiSettings;
  let conversationBotEngagedAt: Date | null;
  let snapshotBotReplyCount: number;
  let chunks: RetrievedChunk[];
  let modelResult: BotCallResult;
  let claimSucceeds: boolean;
  /** Rows the pause statement matched — zero when an agent already moved the ticket. */
  let ticketsPaused: number;

  let answer: jest.Mock;
  let recordHandoff: jest.Mock;
  let requestRouting: jest.Mock;
  let writeOutboundText: jest.Mock;
  let dispatch: jest.Mock;
  let enqueue: jest.Mock;
  let botTurnUpdates: Record<string, unknown>[];
  let botTurnCreates: Record<string, unknown>[];
  let ticketUpdates: Record<string, unknown>[];
  let conversationUpdates: Record<string, unknown>[];

  /** The reason on the handoff this turn recorded, or `null` when it made none. */
  function handoffReason(): string | null {
    const [call] = recordHandoff.mock.calls as [[unknown, { reason: string }]];

    return call === undefined ? null : call[1].reason;
  }

  /**
   * What the `bot_turns` row ends up saying.
   *
   * The updates are merged in order rather than read as the last one, because a
   * turn writes twice on the refusal paths — the scores first, then the outcome
   * with the handoff — and asserting on either alone would miss half of what the
   * row records.
   */
  function finalTurn(): Record<string, unknown> {
    return Object.assign({}, ...botTurnUpdates) as Record<string, unknown>;
  }

  /**
   * The bot has already answered once in this conversation.
   *
   * Since the narrowing on 0010 decision 5, a refusal is only terminal once the
   * bot has actually spoken — so a test about the handoff machinery has to put
   * itself on that side of the line deliberately rather than by default.
   */
  function botHasAlreadySpoken(): void {
    conversationBotEngagedAt = new Date('2026-08-16T09:30:00.000Z');
    snapshotBotReplyCount = 1;
  }

  beforeEach(() => {
    snapshotSettings = settings();
    conversationBotEngagedAt = null;
    snapshotBotReplyCount = 0;
    chunks = [STRONG_CHUNK];
    modelResult = answered();
    claimSucceeds = true;
    ticketsPaused = 1;

    botTurnUpdates = [];
    botTurnCreates = [];
    ticketUpdates = [];
    conversationUpdates = [];

    answer = jest.fn(() => Promise.resolve(modelResult));
    recordHandoff = jest.fn(() => Promise.resolve());
    requestRouting = jest.fn(() => Promise.resolve());
    writeOutboundText = jest.fn(() => Promise.resolve(REPLY));
    dispatch = jest.fn(() => Promise.resolve());
    enqueue = jest.fn(() => Promise.resolve('added'));

    const transactionClient = {
      botTurn: {
        updateMany: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          botTurnUpdates.push(data);

          return Promise.resolve({ count: 1 });
        }),
      },
      conversation: {
        updateMany: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          conversationUpdates.push(data);

          return Promise.resolve({ count: 1 });
        }),
      },
      ticket: {
        updateMany: jest.fn((args: { where: unknown; data: Record<string, unknown> }) => {
          ticketUpdates.push({ ...args.data, where: args.where });

          return Promise.resolve({ count: ticketsPaused });
        }),
      },
    };

    const prisma = {
      $tenantTransaction: (work: (tx: unknown) => Promise<unknown>) => work(transactionClient),
      botTurn: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          botTurnCreates.push(data);

          if (!claimSucceeds) {
            // Exactly what Prisma raises when another delivery of the same
            // message claimed the turn first. A real instance, because the
            // classifier reads `instanceof` rather than the shape — a
            // hand-rolled lookalike would let this test pass while the
            // production path re-threw.
            return Promise.reject(
              new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
                code: 'P2002',
                clientVersion: 'spec',
                meta: { target: ['tenant_id', 'inbound_message_id'] },
              }),
            );
          }

          return Promise.resolve({ id: TURN });
        }),
        updateMany: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          botTurnUpdates.push(data);

          return Promise.resolve({ count: 1 });
        }),
      },
      message: { findMany: jest.fn(() => Promise.resolve([])) },
    } as unknown as TenantPrisma;

    const eligibility = {
      snapshot: (): Promise<BotGateSnapshot> =>
        Promise.resolve({
          now: new Date('2026-08-16T10:00:00.000Z'),
          providerConfigured: true,
          featureIncluded: true,
          settings: snapshotSettings,
          hasIndexedKnowledge: true,
          message: { direction: 'inbound', body: 'when do refunds arrive?' },
          conversation: {
            botState: 'off',
            botEngagedAt: conversationBotEngagedAt,
            serviceWindowExpiresAt: new Date('2026-08-16T20:00:00.000Z'),
          },
          optedOut: false,
          botReplyCount: snapshotBotReplyCount,
        }),
    } as unknown as BotEligibilityService;

    service = new BotTurnService(
      prisma,
      eligibility,
      { retrieve: jest.fn(() => Promise.resolve(chunks)) } as unknown as KnowledgeRetrieverService,
      { answer } as unknown as ClaudeClient,
      {
        record: recordHandoff,
        requestRoutingIfUnowned: requestRouting,
      } as unknown as HandoffService,
      { writeOutboundText, dispatch } as unknown as AutomatedMessageSender,
      { enqueue } as unknown as QueueService,
    );
  });

  describe('a confident, grounded answer', () => {
    it('replies to the customer', async () => {
      await expect(service.handle(TRIGGER)).resolves.toBe('replied');

      expect(writeOutboundText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: 'Refunds take five working days.', origin: 'bot' }),
      );
    });

    it('records the composite score and both of its components separately', async () => {
      await service.handle(TRIGGER);

      // Stored apart so re-tuning the threshold is a query rather than a
      // re-derivation from an aggregate (0010 decision 3).
      expect(finalTurn()).toMatchObject({
        outcome: 'replied',
        score: 1,
        modelConfidence: 1,
        retrievalScore: 1,
        citedChunkIds: [CHUNK],
      });
    });

    it('links the turn to the message the customer actually received', async () => {
      await service.handle(TRIGGER);

      expect(finalTurn()).toMatchObject({ replyMessageId: REPLY });
    });

    it('moves the ticket to pending, which is what pauses the SLA clock', async () => {
      await service.handle(TRIGGER);

      // Without this, a perfectly answered conversation still breaches its
      // first-response SLA and pages a supervisor (0010 decision 7).
      expect(ticketUpdates).toEqual([{ status: 'pending', where: { id: TICKET, status: 'open' } }]);
    });

    describe('and the evaluation that makes the pause take effect', () => {
      /**
       * The condition 0006's owner attached to signing off decision 7. The status
       * column alone pauses nothing until something evaluates the ticket: without
       * the enqueue the pause lands only when the breach sweep next reconciles,
       * and the resume arithmetic is wrong in both directions — a customer
       * replying after `due_at` gets a zero-budget breach, one replying before it
       * has the whole bot exchange charged to the human's first-response window.
       */
      it('enqueues an SLA evaluation for the ticket it paused', async () => {
        await service.handle(TRIGGER);

        expect(enqueue).toHaveBeenCalledWith(
          SLA_QUEUE,
          SLA_EVALUATE_TICKET_JOB,
          { tenantId: TENANT, ticketId: TICKET, reason: 'status_changed' },
          expect.objectContaining({ attempts: 3 }),
        );
      });

      it('sends no custom job id, so a later trigger cannot collapse into this one', () => {
        // A ticket-keyed id silently collapsed every trigger after the first into
        // the completed key of the one before it — the bug that made an agent's
        // reply fail to stop a clock. The handler is a reconciler; an id buys
        // nothing.
        return service.handle(TRIGGER).then(() => {
          const [, , , options] = enqueue.mock.calls[0] as [
            string,
            string,
            unknown,
            Record<string, unknown>,
          ];

          expect(options).not.toHaveProperty('jobId');
        });
      });

      it('does not enqueue when the ticket was not the one that moved', async () => {
        // An agent resolved it while the model was thinking, so the guarded
        // update matched nothing. There is no status change to evaluate.
        ticketsPaused = 0;

        await service.handle(TRIGGER);

        expect(enqueue).not.toHaveBeenCalled();
      });

      it('does not enqueue for a conversation with no ticket', async () => {
        await service.handle({ ...TRIGGER, ticketId: null });

        expect(enqueue).not.toHaveBeenCalled();
      });

      it('still replies when the queue is unavailable', async () => {
        // The reply has gone to the customer and the ticket is already `pending`;
        // a Redis blip must degrade to the sweep reconciling late, not fail the
        // turn after the fact.
        enqueue.mockResolvedValue('unavailable');

        await expect(service.handle(TRIGGER)).resolves.toBe('replied');
      });
    });

    it('takes the conversation, guarded so it cannot take it back from a human', async () => {
      await service.handle(TRIGGER);

      expect(conversationUpdates.at(-1)).toMatchObject({ botState: 'bot_active' });
    });

    it('stamps botEngagedAt on the first reply only', async () => {
      await service.handle(TRIGGER);
      expect(conversationUpdates.at(-1)).toHaveProperty('botEngagedAt');

      conversationUpdates.length = 0;
      conversationBotEngagedAt = new Date('2026-08-16T09:00:00.000Z');

      await service.handle(TRIGGER);
      // Moving it per reply would shorten the window the handoff DTO's
      // `botExchange` spans to the last exchange.
      expect(conversationUpdates.at(-1)).not.toHaveProperty('botEngagedAt');
    });

    it('hands off nothing', async () => {
      await service.handle(TRIGGER);

      expect(recordHandoff).not.toHaveBeenCalled();
    });
  });

  describe('the composite score is the minimum of two signals', () => {
    // About the score, not about terminality: an engaged conversation is where a
    // refusal is still a handoff.
    beforeEach(botHasAlreadySpoken);

    it('refuses when retrieval is weak even though the model is certain', async () => {
      // The hallucination case the whole design exists to prevent: an average
      // would let a confident model compensate for material that was not there.
      chunks = [WEAK_CHUNK];

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
      expect(handoffReason()).toBe('low_confidence');
    });

    it('refuses when the model is unsure even though retrieval was strong', async () => {
      modelResult = answered({ confidence: 'low' });

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
      expect(handoffReason()).toBe('low_confidence');
    });

    it('replies at exactly the tenant’s threshold, and refuses just below it', async () => {
      snapshotSettings = settings({ minConfidence: BOT_CONFIDENCE.modelConfidence.medium });
      modelResult = answered({ confidence: 'medium' });

      await expect(service.handle(TRIGGER)).resolves.toBe('replied');

      snapshotSettings = settings({ minConfidence: BOT_CONFIDENCE.modelConfidence.medium + 0.01 });

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
    });

    it('records both component scores on a refused turn, not only the composite', async () => {
      modelResult = answered({ confidence: 'low' });

      await service.handle(TRIGGER);

      expect(finalTurn()).toMatchObject({ modelConfidence: 0.3, retrievalScore: 1 });
    });

    it('clears the claim placeholder, so the row is not a failure that never happened', async () => {
      // Every other terminal write overwrote `error`; this branch did not, and a
      // turn refused purely on score kept reading as `claimed` for ever.
      modelResult = answered({ confidence: 'low' });

      await service.handle(TRIGGER);

      expect(finalTurn().error).toBeNull();
    });
  });

  describe('the citation precondition, which sits outside the score', () => {
    beforeEach(botHasAlreadySpoken);

    it('refuses an answer that cites a chunk this turn never retrieved', async () => {
      // An id the model invented is a fabrication signal, and no score should be
      // able to rescue it.
      modelResult = answered({ citedChunkIds: ['70444444-4444-7444-8444-4444444444ff'] });

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
      expect(handoffReason()).toBe('low_confidence');
      expect(finalTurn()).toMatchObject({ error: 'ungrounded_citation' });
    });

    it('refuses an answer that cites nothing at all', async () => {
      modelResult = answered({ citedChunkIds: [] });

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
      expect(writeOutboundText).not.toHaveBeenCalled();
    });

    it('refuses when the model says it could not answer, whatever its confidence', async () => {
      modelResult = answered({ answered: false });

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
    });
  });

  describe('the handoff paths', () => {
    beforeEach(botHasAlreadySpoken);

    it('hands off on a keyword before spending a retrieval query or a token', async () => {
      snapshotSettings = settings({ handoffKeywords: ['refunds'] });

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
      expect(handoffReason()).toBe('customer_requested');
      expect(answer).not.toHaveBeenCalled();
    });

    it('hands off with no model call when retrieval finds nothing', async () => {
      chunks = [];

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
      expect(handoffReason()).toBe('no_match');
      // TAR-28 AC3 as a code path: with nothing retrieved, no prompt is
      // assembled and no request is sent.
      expect(answer).not.toHaveBeenCalled();
    });

    it('hands off when the provider fails, rather than leaving the customer silent', async () => {
      modelResult = { outcome: 'failed', error: 'timeout', latencyMs: 20_000 };

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
      expect(handoffReason()).toBe('bot_error');
      expect(finalTurn()).toMatchObject({ error: 'timeout' });
    });

    it('asks the router for an owner on every handoff', async () => {
      chunks = [];

      await service.handle(TRIGGER);

      expect(requestRouting).toHaveBeenCalledWith(TICKET, CONTACT);
    });

    it('says nothing to the customer when the tenant configured no handoff message', async () => {
      chunks = [];

      await service.handle(TRIGGER);

      // Opt-in by design: a tenant that hands off on every unmatched greeting
      // would otherwise apologise to everybody who said hello.
      expect(writeOutboundText).not.toHaveBeenCalled();
    });

    it('sends the tenant’s handoff message when one is configured', async () => {
      snapshotSettings = settings({ handoffMessage: 'Let me get a colleague for you.' });
      chunks = [];

      await service.handle(TRIGGER);

      expect(writeOutboundText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: 'Let me get a colleague for you.' }),
      );
      expect(dispatch).toHaveBeenCalled();
    });
  });

  /**
   * The narrowing of 0010 decision 5 (Architect's ruling on TAR-406).
   *
   * Decision 5 put two facts in one state: *a human has been asked for*, and
   * *the bot could not help*. Only the first is terminal. Until this, an opening
   * "hi" that missed the knowledge base disabled the bot for the rest of the
   * conversation — so the customer's real question, one message later, was never
   * eligible to be answered, and TAR-28 AC1 was unreachable through the most
   * ordinary opener there is.
   */
  describe('a bot that has never spoken cannot hand off', () => {
    it('answers the question that follows a greeting it could not match', async () => {
      // AC1 through a realistic opener, and the case that was broken.
      chunks = [];

      await expect(service.handle(TRIGGER)).resolves.toBe('suppressed');

      chunks = [STRONG_CHUNK];

      await expect(
        service.handle({ ...TRIGGER, messageId: '70444444-4444-7444-8444-4444444444e1' }),
      ).resolves.toBe('replied');
    });

    it('leaves the conversation exactly as it found it', async () => {
      chunks = [];

      await service.handle(TRIGGER);

      // No handoff event, no state move, no routing re-request, and nothing said
      // to the customer. The whole point is that the next message is gated afresh.
      expect(recordHandoff).not.toHaveBeenCalled();
      expect(conversationUpdates).toHaveLength(0);
      expect(requestRouting).not.toHaveBeenCalled();
      expect(writeOutboundText).not.toHaveBeenCalled();
    });

    it('still records the refusal, because an operator will ask about it', async () => {
      chunks = [];

      await service.handle(TRIGGER);

      expect(botTurnCreates).toEqual([
        expect.objectContaining({
          outcome: 'suppressed',
          error: 'no_answer_unengaged',
          inboundMessageId: MESSAGE,
        }),
      ]);
    });

    it('suppresses a low-confidence answer too, or the defect survives by a second door', async () => {
      // A greeting that clears the trigram floor reaches the model and comes back
      // unable to answer. Same outcome for the customer as `no_match`; it must
      // not be the one that stays terminal.
      modelResult = answered({ answered: false });

      await expect(service.handle(TRIGGER)).resolves.toBe('suppressed');
      expect(recordHandoff).not.toHaveBeenCalled();
    });

    it('updates the claimed row rather than inserting a second one', async () => {
      // `suppress()` inserts, and the claim already holds
      // `(tenant_id, inbound_message_id)` — calling it here would throw a unique
      // violation on a path whose whole purpose is to do nothing.
      modelResult = answered({ answered: false });

      await service.handle(TRIGGER);

      expect(botTurnCreates).toHaveLength(1);
      expect(finalTurn()).toMatchObject({
        outcome: 'suppressed',
        error: 'no_answer_unengaged',
      });
    });

    it('clears the claim’s handoff reason, which the database will not accept', async () => {
      // `bot_turns_handoff_reason_matches_outcome` is a biconditional, and the
      // pessimistic claim writes `bot_error`. A suppressed row that kept it is
      // rejected outright — a check violation thrown on the path whose whole
      // purpose is to do nothing, and one no mock would ever show.
      modelResult = answered({ answered: false });

      await service.handle(TRIGGER);

      expect(finalTurn().handoffReason).toBeNull();
    });

    it('still hands off when the customer asks for a person', async () => {
      // The one thing the bot must never talk its way out of.
      snapshotSettings = settings({ handoffKeywords: ['refunds'] });

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
      expect(handoffReason()).toBe('customer_requested');
    });

    it('still hands off when the provider fails', async () => {
      // A provider incident fails toward a human, per 0010's failure table.
      modelResult = { outcome: 'failed', error: 'timeout', latencyMs: 20_000 };

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
      expect(handoffReason()).toBe('bot_error');
    });

    it('does not leak into a conversation the bot has already answered in', async () => {
      // Turn two missing the knowledge base is a real handoff: the customer is
      // mid-conversation with a bot that has stopped being able to help.
      botHasAlreadySpoken();
      chunks = [];

      await expect(service.handle(TRIGGER)).resolves.toBe('handed_off');
      expect(handoffReason()).toBe('no_match');
    });
  });

  describe('the idempotency guard', () => {
    it('claims the turn before calling the model', async () => {
      await service.handle(TRIGGER);

      // A deterministic job id de-duplicates a re-enqueue; it does not
      // de-duplicate a worker that crashed after sending.
      expect(botTurnCreates).toHaveLength(1);
      expect(answer).toHaveBeenCalledTimes(1);
    });

    it('claims pessimistically, so a crash mid-turn reads as “nothing was sent”', async () => {
      await service.handle(TRIGGER);

      expect(botTurnCreates[0]).toMatchObject({
        outcome: 'handed_off',
        handoffReason: 'bot_error',
      });
    });

    it('does nothing when another delivery already claimed the message', async () => {
      claimSucceeds = false;

      await expect(service.handle(TRIGGER)).resolves.toBe('suppressed');
      expect(answer).not.toHaveBeenCalled();
      expect(writeOutboundText).not.toHaveBeenCalled();
    });
  });
});
