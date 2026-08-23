import { describe, expect, it } from 'vitest';
import type { AiConfigResponse, AiReadinessBlocker } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { SourceHealth } from './chatbot.data';
import { chatbotPipeline, type PipelineStageId } from './pipeline';

/**
 * The rail's whole claim is that the flow stops where the bot stops, and that
 * every stage says its state in words as well as in a colour. Both are
 * assertions about this function rather than about the markup, which is why they
 * are here: a dot the wrong colour is a bug somebody notices, and a *connector*
 * the wrong colour is a bug that quietly tells an admin to go and fix the wrong
 * setting.
 */

function config(overrides: Partial<AiConfigResponse> = {}): AiConfigResponse {
  return {
    isEnabled: true,
    model: null,
    minConfidence: 0.6,
    maxBotTurns: 5,
    systemPrompt: null,
    handoffMessage: 'Someone from our team will pick this up.',
    handoffKeywords: [],
    availableModels: [],
    readiness: { ready: true, indexedDocumentCount: 14, blockers: [] },
    updatedAt: '2026-08-01T09:05:00.000Z',
    ...overrides,
  };
}

function health(overrides: Partial<SourceHealth> = {}): SourceHealth {
  return {
    readyCount: 14,
    indexingCount: 0,
    failedCount: 0,
    isIndexingCapped: false,
    isFailedCapped: false,
    ...overrides,
  };
}

function blocked(blockers: readonly AiReadinessBlocker[]): AiConfigResponse {
  return config({ readiness: { ready: false, indexedDocumentCount: 0, blockers: [...blockers] } });
}

function stage(pipeline: ReturnType<typeof chatbotPipeline>, id: PipelineStageId) {
  const found = pipeline.stages.find((entry) => entry.id === id);

  if (found === undefined) {
    throw new Error(`No stage ${id}`);
  }

  return found;
}

describe('the chatbot pipeline', () => {
  it('is always the same four stages, in the order the bot checks them', () => {
    // The shape is a picture of ADR 0010's decision order, not a graph anybody
    // builds: nothing about a configuration adds, removes or reorders a stage.
    const ids = chatbotPipeline(content, config(), health()).stages.map((entry) => entry.id);

    expect(ids).toEqual(['sources', 'eligibility', 'confidence', 'handoff']);
    expect(
      chatbotPipeline(content, blocked(['disabled']), health()).stages.map((s) => s.id),
    ).toEqual(ids);
  });

  it('carries the flow all the way through when the bot is answering', () => {
    const pipeline = chatbotPipeline(content, config(), health());

    expect(pipeline.stages.every((entry) => entry.isFlowing)).toBe(true);
    expect(pipeline.stages.every((entry) => entry.tone === 'live')).toBe(true);
  });

  it('stops the flow at the stage that blocks, and leaves the rest inert', () => {
    // The one assertion the whole rail exists for. A bot that is switched off
    // never reaches the threshold, so drawing stage C green after an amber
    // stage B would say the opposite of what is happening.
    const pipeline = chatbotPipeline(content, blocked(['disabled']), health());

    expect(stage(pipeline, 'sources').isFlowing).toBe(true);
    expect(stage(pipeline, 'eligibility').tone).toBe('blocking');
    expect(stage(pipeline, 'eligibility').isFlowing).toBe(false);
    expect(stage(pipeline, 'confidence').tone).toBe('inert');
    expect(stage(pipeline, 'handoff').tone).toBe('inert');
  });

  it('blocks at the sources when there is nothing indexed', () => {
    const pipeline = chatbotPipeline(
      content,
      blocked(['no_indexed_documents']),
      health({ readyCount: 0 }),
    );

    expect(stage(pipeline, 'sources').tone).toBe('blocking');
    expect(stage(pipeline, 'sources').isFlowing).toBe(false);
    expect(stage(pipeline, 'sources').value).toBe(content.chatbot.stageSourcesNone);
  });

  it('marks the whole rail inert for a condition that is not a stage', () => {
    // The provider and the plan are properties of the deployment and the
    // subscription. Colouring a stage for either would send an admin to change
    // a setting that is not the problem.
    const pipeline = chatbotPipeline(content, blocked(['provider_not_configured']), health());

    expect(pipeline.conditions).toEqual(['provider_not_configured']);
    expect(pipeline.stages.every((entry) => entry.tone === 'inert')).toBe(true);
    expect(pipeline.stages.every((entry) => !entry.isFlowing)).toBe(true);
  });

  it('flags a failed source without stopping a bot that can still answer', () => {
    const pipeline = chatbotPipeline(content, config(), health({ failedCount: 2 }));

    expect(stage(pipeline, 'sources').tone).toBe('failed');
    expect(stage(pipeline, 'sources').isFlowing).toBe(true);
  });

  it('says every state in words, so colour is never the only carrier', () => {
    const pipeline = chatbotPipeline(content, config(), health({ failedCount: 2 }));

    expect(stage(pipeline, 'sources').value).toContain(content.chatbot.stageSourcesFailed(2));
    expect(stage(pipeline, 'eligibility').value).toBe(content.chatbot.stageEligibilityOn(5));
    expect(stage(pipeline, 'confidence').value).toBe(content.chatbot.stageConfidence('60%'));
    expect(stage(pipeline, 'handoff').value).toBe(content.chatbot.stageHandoffMessage);
  });

  it('reads a whitespace-only handoff message as saying nothing', () => {
    // `'   '` is `null` by the time it reaches the API — the form trims it — so a
    // rail claiming the customer gets a message would be describing a value that
    // no longer exists by the time it is saved.
    const pipeline = chatbotPipeline(content, config({ handoffMessage: '   ' }), health());

    expect(stage(pipeline, 'handoff').value).toBe(content.chatbot.stageHandoffSilent);
  });

  it('puts the state into the link’s own name, not only into the dot', () => {
    const pipeline = chatbotPipeline(content, blocked(['disabled']), health());
    const eligibility = stage(pipeline, 'eligibility');

    expect(eligibility.linkName).toBe(
      content.chatbot.stageLinkNameBlocking(eligibility.label, eligibility.value),
    );
    expect(stage(pipeline, 'sources').linkName).toBe(
      content.chatbot.stageLinkName(
        stage(pipeline, 'sources').label,
        stage(pipeline, 'sources').value,
      ),
    );
  });
});
