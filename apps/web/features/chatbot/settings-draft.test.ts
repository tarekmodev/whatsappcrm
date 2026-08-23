import { describe, expect, it } from 'vitest';
import type { AiConfigResponse } from '@whatsappcrm/contracts';
import { draftChangeCount, draftInput, settingsDraft } from './settings-draft';

/**
 * What the save bar appears for, and what it must not appear for.
 *
 * This is the one thing on the chatbot surface a reader cannot check for
 * themselves: a bar that stays away while something is unsaved loses their work
 * silently, and a bar that appears when nothing changed teaches them to press
 * Save on a request that writes nothing.
 */

const CONFIG: AiConfigResponse = {
  isEnabled: true,
  model: 'claude-sonnet-5',
  minConfidence: 0.6,
  maxBotTurns: 5,
  systemPrompt: 'Be brief.',
  handoffMessage: 'Someone will be with you.',
  handoffKeywords: ['agent', 'human'],
  availableModels: [],
  readiness: { ready: true, indexedDocumentCount: 14, blockers: [] },
  updatedAt: '2026-08-01T09:05:00.000Z',
};

const SAVED = settingsDraft(CONFIG);

describe('the settings draft', () => {
  it('starts clean', () => {
    expect(draftChangeCount(SAVED, SAVED)).toBe(0);
  });

  it('counts each changed field once', () => {
    const draft = { ...SAVED, minConfidence: 0.75, systemPrompt: 'Be very brief.' };

    expect(draftChangeCount(draft, SAVED)).toBe(2);
  });

  it('ignores whitespace the save would have dropped anyway', () => {
    // A trailing newline in the keyword box and a space at the end of the prompt
    // both vanish on the way to the API. Counting them would put a save bar over
    // a form with nothing to save, and then report "Saved" for a no-op.
    const draft = {
      ...SAVED,
      systemPrompt: `${SAVED.systemPrompt}  `,
      handoffMessage: `  ${SAVED.handoffMessage}`,
      keywordText: `${SAVED.keywordText}\n\n`,
    };

    expect(draftChangeCount(draft, SAVED)).toBe(0);
  });

  it('counts a reordered keyword list, because order is the reader’s', () => {
    // `parseKeywords` keeps the order it was given rather than sorting, so moving
    // a word up the box is a change somebody made and would expect to save.
    expect(draftChangeCount({ ...SAVED, keywordText: 'human\nagent' }, SAVED)).toBe(1);
  });

  it('counts an emptied reply limit, so the bar can carry the reader to the error', () => {
    // `''` is not a number yet. Treated as unchanged it would leave the reader
    // with an invalid field, no bar and no way to find out.
    expect(draftChangeCount({ ...SAVED, maxBotTurns: '' }, SAVED)).toBe(1);
  });

  it('never sends `isEnabled`, so a saved prompt cannot switch the chatbot back on', () => {
    // The switch writes on its own. A stale copy of its value riding along with
    // every other save is how a bot somebody turned off comes back.
    expect(draftInput(SAVED)).not.toHaveProperty('isEnabled');
  });

  it('spells the platform default `null` rather than the select’s empty string', () => {
    expect(draftInput({ ...SAVED, model: '' }).model).toBeNull();
    expect(draftInput(SAVED).model).toBe('claude-sonnet-5');
  });

  it('spells an emptied text field `null`, which is what "say nothing" means', () => {
    const input = draftInput({ ...SAVED, systemPrompt: '   ', handoffMessage: '' });

    expect(input.systemPrompt).toBeNull();
    expect(input.handoffMessage).toBeNull();
  });
});
