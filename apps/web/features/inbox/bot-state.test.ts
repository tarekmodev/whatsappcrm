import { describe, expect, it } from 'vitest';
import { CONVERSATION_BOT_STATES, MESSAGE_ORIGINS } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { BOT_STATE_TONES, hasBotStateBadge, isBotMessage } from './bot-state';

/**
 * The distinction TAR-28's second acceptance criterion rests on: the inbox has
 * to tell a conversation the chatbot is answering from one it has handed over,
 * and both from one it never touched.
 */

describe('bot state badges', () => {
  it('covers every state the contract publishes', () => {
    // A state added to the contract without copy and a tone would render an
    // empty badge, which is worse than none.
    for (const state of CONVERSATION_BOT_STATES) {
      expect(BOT_STATE_TONES).toHaveProperty(state);
      expect(content.inbox.botStates).toHaveProperty(state);
    }
  });

  it('labels a bot-answering conversation', () => {
    expect(hasBotStateBadge('bot_active')).toBe(true);
    expect(content.inbox.botStates.bot_active).not.toBe('');
  });

  it('labels a handed-over conversation differently from a bot-answering one', () => {
    // The case the boolean `botHandling` cannot express: it reads `false` for
    // both `handed_off` and `off`, and only one of them needs somebody now.
    expect(hasBotStateBadge('handed_off')).toBe(true);
    expect(content.inbox.botStates.handed_off).not.toBe(content.inbox.botStates.bot_active);
  });

  it('leaves a conversation the chatbot never touched unlabelled', () => {
    expect(hasBotStateBadge('off')).toBe(false);
    expect(BOT_STATE_TONES.off).toBeNull();
  });
});

describe('isBotMessage', () => {
  it('is true only for the chatbot', () => {
    // `system` is a workflow reply or a status placeholder. Captioning either
    // one "Sent by the chatbot" would name the wrong system.
    expect(MESSAGE_ORIGINS.filter(isBotMessage)).toEqual(['bot']);
  });
});
