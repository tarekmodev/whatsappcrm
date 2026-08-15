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
    const title = 'a'.repeat(KNOWLEDGE_DOCUMENT_LIMITS.titleMaxLength + 1);

    expect(validateEntry({ ...valid, title })).toEqual({
      title: content.chatbot.entryTitleTooLongError(KNOWLEDGE_DOCUMENT_LIMITS.titleMaxLength),
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
  it('accepts a short list', () => {
    expect(validateSettings(['agent', 'human'])).toEqual({});
  });

  it('rejects a single keyword past the per-keyword length', () => {
    const keyword = 'a'.repeat(AI_CONFIG_LIMITS.handoffKeywordMaxLength + 1);

    expect(validateSettings([keyword])).toEqual({
      handoffKeywords: content.chatbot.handoffKeywordTooLongError(
        AI_CONFIG_LIMITS.handoffKeywordMaxLength,
      ),
    });
  });

  it('rejects more keywords than the contract allows', () => {
    const keywords = Array.from(
      { length: AI_CONFIG_LIMITS.maxHandoffKeywords + 1 },
      (_unused, index) => `keyword-${index}`,
    );

    expect(validateSettings(keywords)).toEqual({
      handoffKeywords: content.chatbot.handoffKeywordsTooManyError(
        AI_CONFIG_LIMITS.maxHandoffKeywords,
      ),
    });
  });
});
