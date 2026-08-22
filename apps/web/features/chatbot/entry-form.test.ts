import { describe, expect, it } from 'vitest';
import { AI_CONFIG_LIMITS, KNOWLEDGE_DOCUMENT_LIMITS } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { formatKeywords, parseKeywords, validateEntry, validateSettings } from './entry-form';

/**
 * The validation the chatbot forms run before they spend a round trip, and the
 * keyword parsing that turns a textarea into the contract's array.
 *
 * The bounds are read from the contract in the assertions too, so a limit that
 * moves in `ai.ts` moves the test with it rather than leaving a stale literal
 * passing against a rule nobody enforces any more.
 */

describe('validateEntry', () => {
  const valid = { title: 'Returns policy', body: 'Thirty days.', sourceUrl: '' };

  it('accepts an entry with a title and a body', () => {
    expect(validateEntry(valid)).toEqual({});
  });

  it('rejects a title that is only whitespace', () => {
    // Trimmed before it is measured: a form that accepted three spaces would
    // create an entry nobody can find in the list.
    expect(validateEntry({ ...valid, title: '   ' })).toEqual({
      title: content.form.requiredFieldError,
    });
  });

  it('rejects a body that is only whitespace', () => {
    expect(validateEntry({ ...valid, body: ' \n ' })).toEqual({
      content: content.form.requiredFieldError,
    });
  });

  it('rejects a title past the contract’s length', () => {
    const title = 'a'.repeat(KNOWLEDGE_DOCUMENT_LIMITS.titleLength + 1);

    expect(validateEntry({ ...valid, title })).toEqual({
      title: content.chatbot.entryTitleTooLongError(KNOWLEDGE_DOCUMENT_LIMITS.titleLength),
    });
  });

  it('accepts an https source URL', () => {
    expect(validateEntry({ ...valid, sourceUrl: 'https://northwind.example/help' })).toEqual({});
  });

  it('rejects a source URL that is not a web address', () => {
    // The value is rendered as a link for the tenant's own team, so a scheme
    // check is not pedantry — `javascript:` parses perfectly as a URL.
    expect(validateEntry({ ...valid, sourceUrl: 'javascript:alert(1)' })).toEqual({
      sourceUrl: content.chatbot.entrySourceUrlInvalidError,
    });
  });

  it('treats an empty source URL as absent rather than invalid', () => {
    expect(validateEntry({ ...valid, sourceUrl: '  ' })).toEqual({});
  });

  it('rejects a body past the contract’s cap', () => {
    const body = 'a'.repeat(KNOWLEDGE_DOCUMENT_LIMITS.contentBytes + 1);

    expect(validateEntry({ ...valid, body })).toEqual({
      content: content.chatbot.entryContentTooLongError,
    });
  });

  it('counts the body in UTF-8 bytes, so the cap means the same thing in Arabic', () => {
    // The case this check used to pass and the API then refused: Arabic is two
    // UTF-8 bytes per letter, so half the cap in letters is the whole cap in
    // bytes. Ported from the contract's own `ai.test.ts`.
    const arabic = 'ن'.repeat(KNOWLEDGE_DOCUMENT_LIMITS.contentBytes / 2 + 1);

    expect(arabic.length).toBeLessThan(KNOWLEDGE_DOCUMENT_LIMITS.contentBytes);
    expect(validateEntry({ ...valid, body: arabic })).toEqual({
      content: content.chatbot.entryContentTooLongError,
    });
  });

  it('accepts a body at exactly the cap', () => {
    const body = 'a'.repeat(KNOWLEDGE_DOCUMENT_LIMITS.contentBytes);

    expect(validateEntry({ ...valid, body })).toEqual({});
  });
});

describe('parseKeywords', () => {
  it('splits on newlines and trims each keyword', () => {
    expect(parseKeywords('agent\n  human  \nperson')).toEqual(['agent', 'human', 'person']);
  });

  it('drops blank lines rather than rejecting them', () => {
    // A list typed into a textarea acquires these by accident; refusing a save
    // over a trailing newline would be a refusal about nothing the user chose.
    expect(parseKeywords('agent\n\n\nhuman\n')).toEqual(['agent', 'human']);
  });

  it('collapses duplicates', () => {
    expect(parseKeywords('agent\nagent')).toEqual(['agent']);
  });

  it('round-trips through formatKeywords', () => {
    expect(parseKeywords(formatKeywords(['agent', 'human']))).toEqual(['agent', 'human']);
  });
});

describe('validateSettings', () => {
  const valid = { keywords: ['agent', 'human'], maxBotTurns: '5' };

  it('accepts a short list and a turn count inside the bounds', () => {
    expect(validateSettings(valid)).toEqual({});
  });

  it('rejects a single keyword past the per-keyword length', () => {
    const keyword = 'a'.repeat(AI_CONFIG_LIMITS.handoffKeywordLength + 1);

    expect(validateSettings({ ...valid, keywords: [keyword] })).toEqual({
      handoffKeywords: content.chatbot.handoffKeywordTooLongError(
        AI_CONFIG_LIMITS.handoffKeywordLength,
      ),
    });
  });

  it('rejects more keywords than the contract allows', () => {
    const keywords = Array.from(
      { length: AI_CONFIG_LIMITS.handoffKeywordCount + 1 },
      (_unused, index) => `keyword-${index}`,
    );

    expect(validateSettings({ ...valid, keywords })).toEqual({
      handoffKeywords: content.chatbot.handoffKeywordsTooManyError(
        AI_CONFIG_LIMITS.handoffKeywordCount,
      ),
    });
  });

  describe('the turn count', () => {
    const turnsError = content.chatbot.maxTurnsInvalidError(
      AI_CONFIG_LIMITS.minBotTurns,
      AI_CONFIG_LIMITS.maxBotTurns,
    );

    it('rejects an emptied field rather than letting it submit as zero', () => {
      // The reason this check exists: `Number('')` is `0`, which the contract
      // refuses and nobody typed, and it surfaced as a generic failure with
      // nothing on screen highlighted.
      expect(validateSettings({ ...valid, maxBotTurns: '' })).toEqual({
        maxBotTurns: turnsError,
      });
    });

    it('rejects a value below the contract’s floor', () => {
      expect(
        validateSettings({ ...valid, maxBotTurns: String(AI_CONFIG_LIMITS.minBotTurns - 1) }),
      ).toEqual({ maxBotTurns: turnsError });
    });

    it('rejects a value above the contract’s ceiling', () => {
      expect(
        validateSettings({ ...valid, maxBotTurns: String(AI_CONFIG_LIMITS.maxBotTurns + 1) }),
      ).toEqual({ maxBotTurns: turnsError });
    });

    it('rejects a fraction, which the contract stores as a whole number', () => {
      expect(validateSettings({ ...valid, maxBotTurns: '2.5' })).toEqual({
        maxBotTurns: turnsError,
      });
    });

    it('accepts both bounds', () => {
      expect(
        validateSettings({ ...valid, maxBotTurns: String(AI_CONFIG_LIMITS.minBotTurns) }),
      ).toEqual({});
      expect(
        validateSettings({ ...valid, maxBotTurns: String(AI_CONFIG_LIMITS.maxBotTurns) }),
      ).toEqual({});
    });
  });
});
