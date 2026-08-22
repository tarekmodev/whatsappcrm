import { AI_CONFIG_DEFAULTS, type BotInboundTrigger } from '@whatsappcrm/contracts';
import type { ConfigService } from '@nestjs/config';
import type { PlanFeaturesService } from '../entitlements/plan-features.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { AiSettings } from './ai-config.service';
import {
  BotEligibilityService,
  decideEligibility,
  type BotGateSnapshot,
} from './bot-eligibility.service';

/**
 * The gate, which is where TAR-28's third acceptance criterion is actually
 * enforced:
 *
 * > Given a tenant has not configured a knowledge base, when a conversation
 * > starts, then the bot does not attempt automated replies.
 *
 * It is a pure function precisely so that criterion can be proved without a
 * model, a queue or a database — and the property it proves is stronger than
 * "the model behaved": on every refusal below, no prompt is assembled and no
 * request is made, so a hallucinated answer is not merely unlikely but
 * unreachable.
 */

const NOW = new Date('2026-08-16T10:00:00.000Z');
const OPEN_WINDOW = new Date('2026-08-16T20:00:00.000Z');

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    isEnabled: true,
    model: null,
    systemPrompt: null,
    handoffKeywords: [],
    minConfidence: AI_CONFIG_DEFAULTS.minConfidence,
    maxBotTurns: AI_CONFIG_DEFAULTS.maxBotTurns,
    handoffMessage: null,
    ...overrides,
  };
}

/** A tenant that is fully ready, so each case turns exactly one thing off. */
function snapshot(overrides: Partial<BotGateSnapshot> = {}): BotGateSnapshot {
  return {
    now: NOW,
    providerConfigured: true,
    featureIncluded: true,
    settings: settings(),
    hasIndexedKnowledge: true,
    message: { direction: 'inbound', body: 'where is my order?' },
    conversation: {
      botState: 'off',
      botEngagedAt: null,
      serviceWindowExpiresAt: OPEN_WINDOW,
    },
    optedOut: false,
    botReplyCount: 0,
    ...overrides,
  };
}

describe('decideEligibility', () => {
  it('admits a ready tenant and carries the trimmed question forward', () => {
    expect(
      decideEligibility(snapshot({ message: { direction: 'inbound', body: '  hi?  ' } })),
    ).toEqual({ outcome: 'admit', question: 'hi?' });
  });

  describe('TAR-28 AC3 — no knowledge base means no automated reply', () => {
    it('suppresses when the tenant has no indexed content', () => {
      expect(decideEligibility(snapshot({ hasIndexedKnowledge: false }))).toEqual({
        outcome: 'suppress',
        reason: 'no_knowledge_base',
      });
    });

    it('suppresses silently — never as a handoff, so the thread is unchanged', () => {
      // A handoff would write a customer-visible event and re-request routing on
      // a tenant that has simply not switched the feature on.
      expect(decideEligibility(snapshot({ hasIndexedKnowledge: false })).outcome).not.toBe(
        'handoff',
      );
    });
  });

  describe('the platform and tenant clauses, in the order they are cheapest', () => {
    it('suppresses when the deployment holds no provider key', () => {
      expect(decideEligibility(snapshot({ providerConfigured: false }))).toEqual({
        outcome: 'suppress',
        reason: 'provider_not_configured',
      });
    });

    it('suppresses when the plan does not include the chatbot', () => {
      expect(decideEligibility(snapshot({ featureIncluded: false }))).toEqual({
        outcome: 'suppress',
        reason: 'feature_not_in_plan',
      });
    });

    it('suppresses when the tenant has switched the bot off', () => {
      expect(decideEligibility(snapshot({ settings: settings({ isEnabled: false }) }))).toEqual({
        outcome: 'suppress',
        reason: 'disabled',
      });
    });

    it('reports the first failing clause rather than whichever else is also true', () => {
      // `bot_turns.error` is only worth querying if the reason is the one an
      // operator can act on.
      expect(
        decideEligibility(
          snapshot({
            providerConfigured: false,
            featureIncluded: false,
            hasIndexedKnowledge: false,
          }),
        ),
      ).toEqual({ outcome: 'suppress', reason: 'provider_not_configured' });
    });
  });

  describe('the opt-out, which is the one clause about a person', () => {
    it('sends nothing to a contact who has opted out', () => {
      expect(decideEligibility(snapshot({ optedOut: true }))).toEqual({
        outcome: 'suppress',
        reason: 'opted_out',
      });
    });

    it('suppresses rather than hands off, because a handoff may still send a message', () => {
      // The tenant's `handoffMessage` is an outbound WhatsApp message like any
      // other. Silence is the only outcome that honours the opt-out, and the
      // customer's message is in the inbox with a ticket either way.
      expect(decideEligibility(snapshot({ optedOut: true })).outcome).toBe('suppress');
    });

    it('outranks the turn cap, so no handoff message reaches an opted-out contact', () => {
      // The ordering that matters: `max_turns` alone is a handoff, and a handoff
      // that fires first would be the one path on which someone who asked us to
      // stop still hears from us.
      expect(
        decideEligibility(
          snapshot({ optedOut: true, settings: settings({ maxBotTurns: 2 }), botReplyCount: 2 }),
        ),
      ).toEqual({ outcome: 'suppress', reason: 'opted_out' });
    });
  });

  describe('the conversation clauses', () => {
    it('never answers into a thread a human has taken', () => {
      // Terminal on purpose: a bot that resumes after an agent has spoken talks
      // over a colleague in front of the customer.
      expect(
        decideEligibility(
          snapshot({
            conversation: {
              botState: 'human_active',
              botEngagedAt: NOW,
              serviceWindowExpiresAt: OPEN_WINDOW,
            },
          }),
        ),
      ).toEqual({ outcome: 'suppress', reason: 'already_released' });
    });

    it('never answers into a thread it has already released', () => {
      // `handed_off` has no transition back to `bot_active` in 0010 decision 5's
      // state machine — the conversation has been given to a person who has not
      // picked it up yet.
      expect(
        decideEligibility(
          snapshot({
            conversation: {
              botState: 'handed_off',
              botEngagedAt: NOW,
              serviceWindowExpiresAt: OPEN_WINDOW,
            },
          }),
        ),
      ).toEqual({ outcome: 'suppress', reason: 'already_released' });
    });

    it('suppresses an outbound message, which is never a question to answer', () => {
      expect(
        decideEligibility(snapshot({ message: { direction: 'outbound', body: 'On its way.' } })),
      ).toEqual({ outcome: 'suppress', reason: 'not_inbound' });
    });

    it('suppresses a message with no text, such as a sticker or a bare photo', () => {
      expect(
        decideEligibility(snapshot({ message: { direction: 'inbound', body: null } })),
      ).toEqual({ outcome: 'suppress', reason: 'empty_message' });
    });

    it('suppresses once the customer service window has closed', () => {
      expect(
        decideEligibility(
          snapshot({
            conversation: {
              botState: 'off',
              botEngagedAt: null,
              serviceWindowExpiresAt: new Date('2026-08-16T09:00:00.000Z'),
            },
          }),
        ),
      ).toEqual({ outcome: 'suppress', reason: 'window_closed' });
    });

    it('suppresses when the rows the trigger names are not readable', () => {
      expect(decideEligibility(snapshot({ message: null }))).toEqual({
        outcome: 'suppress',
        reason: 'unreadable',
      });
    });
  });

  describe('the turn cap', () => {
    it('hands off rather than suppressing, so the customer is not stranded', () => {
      expect(
        decideEligibility(snapshot({ settings: settings({ maxBotTurns: 2 }), botReplyCount: 2 })),
      ).toEqual({ outcome: 'handoff', reason: 'max_turns' });
    });

    it('admits the turn that reaches the cap, and refuses the one after it', () => {
      const capped = settings({ maxBotTurns: 2 });

      expect(decideEligibility(snapshot({ settings: capped, botReplyCount: 1 })).outcome).toBe(
        'admit',
      );
      expect(decideEligibility(snapshot({ settings: capped, botReplyCount: 2 })).outcome).toBe(
        'handoff',
      );
    });
  });
});

/**
 * The one part of the gate that is not a pure function: what `snapshot()`
 * actually reads.
 *
 * Worth its own tests because the two inputs the engagement rules stand on —
 * `bot_engaged_at` and the reply count — have to describe the *same* span of
 * time, and nothing in the type system says so.
 */
describe('BotEligibilityService.snapshot', () => {
  const CONVERSATION = '70444444-4444-7444-8444-4444444444c1';
  const ENGAGED_AT = new Date('2026-08-20T09:00:00.000Z');

  const TRIGGER = {
    tenantId: '70444444-4444-7444-8444-444444444401',
    conversationId: CONVERSATION,
    contactId: '70444444-4444-7444-8444-4444444444d1',
    messageId: '70444444-4444-7444-8444-4444444444e0',
    ticketId: null,
    receivedAt: '2026-08-20T10:00:00.000Z',
  } satisfies BotInboundTrigger;

  function build(botEngagedAt: Date | null, repliesSinceEngagement = 0) {
    const count = jest.fn(() => Promise.resolve(repliesSinceEngagement));

    const prisma = {
      aiConfig: { findFirst: jest.fn(() => Promise.resolve(null)) },
      message: {
        findUnique: jest.fn(() => Promise.resolve({ direction: 'inbound', body: 'hi' })),
      },
      conversation: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            botState: 'off',
            botEngagedAt,
            serviceWindowExpiresAt: new Date('2026-08-20T20:00:00.000Z'),
            contact: { optedOutAt: null },
          }),
        ),
      },
      knowledgeDocument: { findFirst: jest.fn(() => Promise.resolve({ id: 'doc' })) },
      knowledgeChunk: { findFirst: jest.fn(() => Promise.resolve({ id: 'chunk' })) },
      botTurn: { count },
    } as unknown as TenantPrisma;

    const service = new BotEligibilityService(
      prisma,
      { get: () => 'sk-test' } as unknown as ConfigService,
      { includes: () => Promise.resolve(true) } as unknown as PlanFeaturesService,
    );

    return { service, count };
  }

  it('counts no replies at all for a conversation with no engagement running', async () => {
    // The returning customer, and the bug this closes: their old turns are still
    // in `bot_turns` — they are the tuning record and are never deleted — but
    // `bot_engaged_at` was cleared when the conversation was resolved. Counting
    // the lifetime made the gate believe the bot had spoken, so a greeting that
    // missed the knowledge base handed off terminally and the real question that
    // followed was refused as `already_released`.
    const { service, count } = build(null, 7);

    const snapshot = await service.snapshot(TRIGGER, new Date('2026-08-20T10:00:00.000Z'));

    expect(snapshot.botReplyCount).toBe(0);
    // And no query worth making, on the commonest path there is.
    expect(count).not.toHaveBeenCalled();
  });

  it('counts only the replies inside the engagement that is running', async () => {
    const { service, count } = build(ENGAGED_AT, 2);

    const snapshot = await service.snapshot(TRIGGER, new Date('2026-08-20T10:00:00.000Z'));

    // Two after the stamp, plus the one that wrote it.
    expect(snapshot.botReplyCount).toBe(3);
    expect(count).toHaveBeenCalledWith({
      where: {
        conversationId: CONVERSATION,
        outcome: 'replied',
        createdAt: { gte: ENGAGED_AT },
      },
    });
  });

  it('counts the reply that started the engagement, which predates its own stamp', async () => {
    // A turn is claimed before the model is called and `bot_engaged_at` is
    // stamped in the transaction that sends the reply, so the first reply of an
    // engagement always has a `created_at` earlier than the stamp it wrote.
    // Without counting it, the turn cap fires one reply late.
    const { service } = build(ENGAGED_AT, 0);

    const snapshot = await service.snapshot(TRIGGER, new Date('2026-08-20T10:00:00.000Z'));

    expect(snapshot.botReplyCount).toBe(1);
  });

  it('leaves a returning customer eligible, cap and all', async () => {
    // The end-to-end shape of both defects: a contact the bot helped to the cap
    // in a conversation since resolved asks something new.
    const { service } = build(null, 99);

    const snapshot = await service.snapshot(TRIGGER, new Date('2026-08-20T10:00:00.000Z'));

    // Everything else held ready, so the only thing that could refuse this turn
    // is the count — which, before the fix, was 99 and over any cap a tenant can
    // set.
    expect(
      decideEligibility({ ...snapshot, settings: settings({ maxBotTurns: 5 }) }),
    ).toMatchObject({ outcome: 'admit' });
  });
});
