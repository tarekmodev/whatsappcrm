import { matchHandoffKeyword, normaliseForKeywordMatch } from './handoff-keywords';

/**
 * The rule 0010 wrote down rather than leaving to the implementation: NFKC
 * normalised, case-folded, Arabic diacritics and tatweel stripped, then a
 * substring match.
 *
 * Every case here is a way a customer actually types — punctuation, a stretched
 * word, a stray vowel mark — and each one fails silently if the rule is wrong:
 * the bot keeps answering somebody who asked for a person.
 */

describe('normaliseForKeywordMatch', () => {
  it('folds case', () => {
    expect(normaliseForKeywordMatch('AGENT')).toBe('agent');
  });

  it('strips the tatweel, which carries no meaning and is inserted for justification', () => {
    expect(normaliseForKeywordMatch('مـــوظف')).toBe(normaliseForKeywordMatch('موظف'));
  });

  it('strips Arabic vowel marks, which a phone keyboard may or may not add', () => {
    expect(normaliseForKeywordMatch('مُوَظَّف')).toBe(normaliseForKeywordMatch('موظف'));
  });

  it('applies NFKC, so a presentation form matches the ordinary one', () => {
    // U+FEF3 is the isolated presentation form of yeh; NFKC folds it back.
    expect(normaliseForKeywordMatch('ﻳ')).toBe('ي');
  });

  it('collapses whitespace runs, so a double space cannot break a match', () => {
    expect(normaliseForKeywordMatch('speak  to\na  human')).toBe('speak to a human');
  });
});

describe('matchHandoffKeyword', () => {
  it('matches inside a sentence, because a keyword is rarely the whole message', () => {
    expect(matchHandoffKeyword('can I speak to an agent please', ['agent'])).toBe('agent');
  });

  it('matches through trailing punctuation, which is why the rule is substring', () => {
    expect(matchHandoffKeyword('agent?', ['agent'])).toBe('agent');
  });

  it('reports which keyword matched, so a log line can name it', () => {
    expect(matchHandoffKeyword('I want a human', ['agent', 'human'])).toBe('human');
  });

  it('matches an Arabic keyword written with diacritics the tenant did not type', () => {
    expect(matchHandoffKeyword('أريد مُوَظَّف', ['موظف'])).toBe('موظف');
  });

  it('does not match when the keyword is absent', () => {
    expect(matchHandoffKeyword('where is my order', ['agent', 'human'])).toBeNull();
  });

  it('does not match on an empty keyword list', () => {
    expect(matchHandoffKeyword('agent', [])).toBeNull();
  });

  it('never matches on a whitespace-only keyword, which would otherwise match everything', () => {
    // Unreachable through the API — the contract requires `min(1)` — but a row
    // written before that validation existed would hand off every conversation.
    expect(matchHandoffKeyword('where is my order', ['   '])).toBeNull();
  });

  it('does not match a message with no body, such as a sticker', () => {
    expect(matchHandoffKeyword(null, ['agent'])).toBeNull();
  });
});
