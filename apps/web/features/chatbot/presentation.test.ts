import { describe, expect, it } from 'vitest';
import type { AiConfigResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { formatConfidence, modelOptions, resolvedModel } from './presentation';

/**
 * How the chatbot surface phrases its two numbers, and which model a `null`
 * choice actually resolves to.
 *
 * `null` is the case worth a test: it means "the platform default", so a page
 * that rendered it as "not set" would tell an admin their chatbot has no model.
 */

const AVAILABLE: AiConfigResponse['availableModels'] = [
  {
    id: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    inputPricePerMTokUsd: 5,
    outputPricePerMTokUsd: 25,
    isDefault: true,
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    inputPricePerMTokUsd: 1,
    outputPricePerMTokUsd: 5,
    isDefault: false,
  },
];

function config(overrides: Partial<AiConfigResponse> = {}): AiConfigResponse {
  return {
    isEnabled: true,
    model: null,
    systemPrompt: null,
    handoffKeywords: [],
    minConfidence: 0.6,
    maxBotTurns: 5,
    handoffMessage: null,
    readiness: { ready: true, indexedDocumentCount: 2, blockers: [] },
    availableModels: AVAILABLE,
    updatedAt: '2026-08-05T10:00:00.000Z',
    ...overrides,
  };
}

describe('resolvedModel', () => {
  it('resolves a null choice to the platform default', () => {
    expect(resolvedModel(config())?.id).toBe('claude-opus-5');
  });

  it('resolves an explicit choice to that model', () => {
    expect(resolvedModel(config({ model: 'claude-haiku-4-5' }))?.id).toBe('claude-haiku-4-5');
  });

  it('resolves to nothing when the API published no default', () => {
    const withoutDefault = AVAILABLE.map((option) => ({ ...option, isDefault: false }));

    expect(resolvedModel(config({ availableModels: withoutDefault }))).toBeUndefined();
  });
});

describe('formatConfidence', () => {
  it('renders a threshold as a whole percentage', () => {
    // `0.60` is a number somebody else calibrated; "60%" is a judgement an admin
    // can hold in their head.
    expect(formatConfidence(content.locale, 0.6)).toBe('60%');
  });

  it('renders the extremes', () => {
    expect(formatConfidence(content.locale, 0)).toBe('0%');
    expect(formatConfidence(content.locale, 1)).toBe('100%');
  });
});

describe('modelOptions', () => {
  it('offers the platform default first, named', () => {
    const options = modelOptions(content, config());

    expect(options[0]).toEqual({
      value: '',
      label: content.chatbot.modelDefaultOption('Claude Opus 5'),
    });
  });

  it('offers every allowlisted model after it', () => {
    expect(modelOptions(content, config()).map((option) => option.value)).toEqual([
      '',
      'claude-opus-5',
      'claude-haiku-4-5',
    ]);
  });
});
