import { describe, expect, it } from 'vitest';
import type { ConversationBotState } from '@whatsappcrm/contracts';
import type { ConversationHold, HoldPermissions } from './conversation-hold';
import { threadState, type ThreadStateInput } from './thread-state';

const EVERY_PERMISSION: HoldPermissions = { canClaim: true, canAssign: true };

function state(overrides: Partial<ThreadStateInput> = {}) {
  return threadState({
    hold: { state: 'mine' } satisfies ConversationHold,
    isUnclaimed: false,
    botState: 'off' satisfies ConversationBotState,
    permissions: EVERY_PERMISSION,
    canSend: true,
    ...overrides,
  });
}

describe('threadState emphasis', () => {
  it('gives an unclaimed thread its claim as the one solid action', () => {
    expect(state({ hold: { state: 'unclaimed' }, isUnclaimed: true }).emphasis).toBe('claim');
  });

  it('keeps the claim solid even while the chatbot is answering', () => {
    // The two used to be solid accent side by side. Stopping the bot does not
    // assign the thread, so claiming is still the gate on replying.
    expect(
      state({ hold: { state: 'unclaimed' }, isUnclaimed: true, botState: 'bot_active' }).emphasis,
    ).toBe('claim');
  });

  it('promotes the handoff once the thread is held', () => {
    expect(state({ botState: 'bot_active' }).emphasis).toBe('handoff');
  });

  it('offers no solid action on a held thread the chatbot has left', () => {
    expect(state().emphasis).toBe('none');
  });

  it('offers no solid action to a role that cannot claim', () => {
    expect(
      state({
        hold: { state: 'unclaimed' },
        isUnclaimed: true,
        botState: 'bot_active',
        permissions: { canClaim: false, canAssign: false },
      }).emphasis,
    ).toBe('none');
  });

  it('does not promote a take-over from a colleague', () => {
    // `Take over` is confirmed and costs a colleague their work; it is never the
    // screen's inviting solid button.
    expect(state({ hold: { state: 'theirs', holderName: 'Amina Haddad' } }).emphasis).toBe('none');
  });
});

describe('threadState guidance', () => {
  it('says nothing on a thread the reader holds and can reply to', () => {
    expect(state().guidance).toBeNull();
  });

  it('reports a role that may read but not reply, before anything else', () => {
    expect(state({ canSend: false, isUnclaimed: true }).guidance).toBe('send-not-permitted');
  });

  it('asks for a claim before mentioning the chatbot', () => {
    // One line, not two: the composer used to carry the claim notice while the
    // header carried an overlapping bot notice about the same thread.
    expect(state({ isUnclaimed: true, botState: 'bot_active' }).guidance).toBe('claim-first');
  });

  it('explains the shared pool differently to a role that cannot claim', () => {
    expect(
      state({ isUnclaimed: true, permissions: { canClaim: false, canAssign: false } }).guidance,
    ).toBe('claim-not-permitted');
  });

  it('explains the silence on a held thread the chatbot is still answering', () => {
    expect(state({ botState: 'bot_active' }).guidance).toBe('bot-answering');
  });

  it('says nothing once the chatbot has handed over', () => {
    expect(state({ botState: 'handed_off' }).guidance).toBeNull();
  });
});

describe('threadState canWrite', () => {
  it('shuts the box on a thread nobody holds', () => {
    expect(state({ isUnclaimed: true }).canWrite).toBe(false);
  });

  it('shuts the box for a role without conversation:send', () => {
    expect(state({ canSend: false }).canWrite).toBe(false);
  });

  it('leaves the box open while the chatbot answers a held thread', () => {
    expect(state({ botState: 'bot_active' }).canWrite).toBe(true);
  });
});
