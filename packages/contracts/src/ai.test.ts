import { describe, expect, it } from 'vitest';
import {
  AI_MODELS,
  AI_MODEL_CATALOG,
  AI_DEFAULT_MODEL,
  BOT_CONFIDENCE,
  BotInboundTriggerSchema,
  CreateKnowledgeDocumentInputSchema,
  KNOWLEDGE_DOCUMENT_LIMITS,
  UpdateKnowledgeDocumentInputSchema,
  UpdateAiConfigInputSchema,
  botInboundJobId,
  compositeConfidence,
  retrievalConfidence,
} from './ai';

/**
 * The confidence arithmetic is published rather than implemented in the worker,
 * so the console, the tests and the bot read one copy. These cases pin the two
 * properties 0010 decision 3 rests on — `min` rather than an average, and a
 * retrieval score that is bounded — and the two contract rules that fail
 * silently: a job id BullMQ would reject, and a threshold outside 0–1.
 */

describe('compositeConfidence', () => {
  it('is the minimum, so neither signal can rescue the other', () => {
    expect(compositeConfidence(1, 0.2)).toBe(0.2);
    expect(compositeConfidence(0.3, 1)).toBe(0.3);
  });

  it('is zero when the model declined, whatever retrieval found', () => {
    // `modelConfidence` is 0 for an unanswered turn, which is what makes the
    // model's verdict a veto rather than a vote.
    expect(compositeConfidence(0, 1)).toBe(0);
  });

  it('is monotone in both inputs, so a threshold keeps a meaning an admin can hold', () => {
    expect(compositeConfidence(0.6, 0.6)).toBeGreaterThan(compositeConfidence(0.6, 0.3));
    expect(compositeConfidence(0.6, 0.6)).toBeGreaterThan(compositeConfidence(0.3, 0.6));
  });
});

describe('retrievalConfidence', () => {
  it('is zero for a rank of zero, which is what makes a refusal expressible', () => {
    expect(retrievalConfidence(0)).toBe(0);
  });

  it('clamps at the target rather than rewarding an unusually high rank', () => {
    expect(retrievalConfidence(BOT_CONFIDENCE.rankTarget)).toBe(1);
    expect(retrievalConfidence(BOT_CONFIDENCE.rankTarget * 10)).toBe(1);
  });

  it('scales linearly below the target', () => {
    expect(retrievalConfidence(BOT_CONFIDENCE.rankTarget / 2)).toBeCloseTo(0.5);
  });

  it('is zero for a value that is not a usable rank', () => {
    expect(retrievalConfidence(Number.NaN)).toBe(0);
    expect(retrievalConfidence(-1)).toBe(0);
  });
});

describe('the model allowlist', () => {
  it('publishes a price for every model a tenant may choose', () => {
    expect(AI_MODEL_CATALOG.map((option) => option.id).sort()).toEqual([...AI_MODELS].sort());
  });

  it('marks exactly one model as the platform default, and it is the named one', () => {
    const defaults = AI_MODEL_CATALOG.filter((option) => option.isDefault);

    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe(AI_DEFAULT_MODEL);
  });

  it('refuses a model id outside the list, so an unknown id is not a live 404', () => {
    expect(UpdateAiConfigInputSchema.safeParse({ model: 'gpt-4' }).success).toBe(false);
  });
});

describe('UpdateAiConfigInputSchema', () => {
  it('bounds the threshold to 0..1, because the composite score is', () => {
    expect(UpdateAiConfigInputSchema.safeParse({ minConfidence: 1.5 }).success).toBe(false);
    expect(UpdateAiConfigInputSchema.safeParse({ minConfidence: 0.6 }).success).toBe(true);
  });

  it('bounds the turn cap, so a tenant cannot disable the loop-breaker', () => {
    expect(UpdateAiConfigInputSchema.safeParse({ maxBotTurns: 0 }).success).toBe(false);
    expect(UpdateAiConfigInputSchema.safeParse({ maxBotTurns: 21 }).success).toBe(false);
  });

  it('accepts null for the model, which means the platform default', () => {
    expect(UpdateAiConfigInputSchema.safeParse({ model: null }).success).toBe(true);
  });
});

describe('botInboundJobId', () => {
  const trigger = BotInboundTriggerSchema.parse({
    tenantId: '70444444-4444-7444-8444-444444444401',
    conversationId: '70444444-4444-7444-8444-4444444444c1',
    contactId: '70444444-4444-7444-8444-4444444444d1',
    messageId: '70444444-4444-7444-8444-4444444444e0',
    ticketId: null,
    receivedAt: '2026-08-16T10:00:00.000Z',
  });

  it('contains no colon, which BullMQ reserves and rejects', () => {
    // A violation surfaces as a logged warning rather than a throw, so the
    // failure mode would be a bot that silently never runs (TAR-249).
    expect(botInboundJobId(trigger)).not.toContain(':');
  });

  it('is stable for the same delivery and distinct across messages', () => {
    expect(botInboundJobId(trigger)).toBe(botInboundJobId(trigger));
    expect(botInboundJobId({ ...trigger, messageId: trigger.conversationId })).not.toBe(
      botInboundJobId(trigger),
    );
  });
});

describe('the knowledge document content cap', () => {
  const cap = KNOWLEDGE_DOCUMENT_LIMITS.contentBytes;

  function parse(content: string) {
    return CreateKnowledgeDocumentInputSchema.safeParse({ title: 'Refund policy', content });
  }

  it('accepts a document at exactly the published size', () => {
    // The case the API used to refuse before it reached any of this: Express
    // capped bodies at 100 KB while the contract advertised 256 KiB.
    expect(parse('a'.repeat(cap)).success).toBe(true);
  });

  it('refuses one byte more', () => {
    expect(parse('a'.repeat(cap + 1)).success).toBe(false);
  });

  it('counts bytes rather than code units, so the limit means one thing in every language', () => {
    // Arabic is two UTF-8 bytes per letter. Counted as UTF-16 code units — which
    // is what `z.string().max()` does — this document was inside a cap named in
    // bytes while being twice its size.
    const arabic = 'ن'.repeat(cap / 2 + 1);

    expect(arabic.length).toBeLessThan(cap);
    expect(parse(arabic).success).toBe(false);
  });

  it('counts an emoji as the four bytes it is, not the two code units it looks like', () => {
    const withEmoji = 'a'.repeat(cap - 4) + '😀';

    expect(withEmoji.length).toBeLessThan(cap);
    expect(parse(withEmoji).success).toBe(true);
    expect(parse('a'.repeat(cap - 3) + '😀').success).toBe(false);
  });

  it('carries the cap through to the update schema, which derives from it', () => {
    expect(UpdateKnowledgeDocumentInputSchema.safeParse({ content: 'a'.repeat(cap) }).success).toBe(
      true,
    );
    expect(
      UpdateKnowledgeDocumentInputSchema.safeParse({ content: 'a'.repeat(cap + 1) }).success,
    ).toBe(false);
  });
});
