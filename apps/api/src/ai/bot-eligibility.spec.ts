import { AI_CONFIG_DEFAULTS } from '@whatsappcrm/contracts';
import type { AiSettings } from './ai-config.service';
import { decideEligibility, type BotGateSnapshot } from './bot-eligibility.service';

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
