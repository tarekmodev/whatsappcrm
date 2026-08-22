import { describe, expect, it } from 'vitest';
import { CANNED_RESPONSE_LIMITS } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import {
  cannedResponseIssues,
  clearIssue,
  hasIssues,
  normaliseShortcut,
  type CannedResponseDraft,
} from './canned-response-form';

/**
 * The rules a saved-reply dialog refuses on, which are the contract's rather
 * than the form's. What is worth holding it to is the pair the API answers
 * differently: a shortcut that is *malformed* and one that is merely *too long*
 * need different fixes, and a form that flattened them into one message would
 * leave an admin retyping a shortcut that was fine.
 */

const VALID: CannedResponseDraft = {
  shortcut: '/hours',
  title: 'Opening hours',
  body: 'We are open Sunday to Thursday.',
};

describe('normaliseShortcut', () => {
  it('adds the leading trigger to a shortcut typed without one', () => {
    // A box labelled Shortcut is unambiguous. Answering `hours` with "must
    // start with /" is punctuation pedantry the field can just apply.
    expect(normaliseShortcut('hours')).toBe('/hours');
  });

  it('lowercases, because `shortcut` is `citext` and `/Hours` is the same row', () => {
    expect(normaliseShortcut('/Hours')).toBe('/hours');
  });

  it('trims, so a pasted shortcut with a trailing space is not malformed', () => {
    expect(normaliseShortcut('  /hours  ')).toBe('/hours');
  });

  it('leaves an empty box empty rather than turning it into a bare trigger', () => {
    // `/` alone is not a shortcut, and reporting "malformed" would be a worse
    // answer than "required" for a field the admin has simply not filled in.
    expect(normaliseShortcut('   ')).toBe('');
  });
});

describe('cannedResponseIssues', () => {
  it('finds nothing wrong with a complete draft', () => {
    expect(cannedResponseIssues(VALID)).toEqual({});
  });

  it.each(['shortcut', 'title', 'body'] as const)('requires %s', (field) => {
    const issues = cannedResponseIssues({ ...VALID, [field]: '' });

    expect(issues[field]).toBe(content.form.requiredFieldError);
  });

  it('reports a malformed shortcut as malformed', () => {
    const issues = cannedResponseIssues({ ...VALID, shortcut: '/two words' });

    expect(issues.shortcut).toBe(content.cannedResponses.shortcutInvalidError('/'));
  });

  it('refuses a second trigger, which would collide with the composer’s own', () => {
    expect(cannedResponseIssues({ ...VALID, shortcut: '/hours/today' }).shortcut).toBeDefined();
  });

  it('reports an over-long shortcut as too long, not as malformed', () => {
    const tooLong = `/${'h'.repeat(CANNED_RESPONSE_LIMITS.shortcutLength)}`;
    const issues = cannedResponseIssues({ ...VALID, shortcut: tooLong });

    expect(issues.shortcut).toBe(
      content.cannedResponses.shortcutTooLongError(CANNED_RESPONSE_LIMITS.shortcutLength),
    );
  });

  it('accepts a shortcut of exactly the published length, including its slash', () => {
    const atLimit = `/${'h'.repeat(CANNED_RESPONSE_LIMITS.shortcutLength - 1)}`;

    expect(cannedResponseIssues({ ...VALID, shortcut: atLimit })).toEqual({});
  });

  it('treats a whitespace-only title or body as empty, as the contract does', () => {
    const issues = cannedResponseIssues({ ...VALID, title: '   ', body: '\n\n' });

    expect(issues.title).toBe(content.form.requiredFieldError);
    expect(issues.body).toBe(content.form.requiredFieldError);
  });
});

describe('clearIssue', () => {
  it('drops one field’s message and leaves the rest', () => {
    const issues = cannedResponseIssues({ shortcut: '', title: '', body: '' });
    const remaining = clearIssue(issues, 'shortcut');

    expect(remaining.shortcut).toBeUndefined();
    expect(remaining.title).toBeDefined();
  });

  it('returns the same object when there was nothing to clear', () => {
    const issues = cannedResponseIssues(VALID);

    // Identity, not equality: an edit to a field with no error must not
    // re-render every other one.
    expect(clearIssue(issues, 'title')).toBe(issues);
  });
});

describe('hasIssues', () => {
  it('is false for a saveable draft and true for anything else', () => {
    expect(hasIssues(cannedResponseIssues(VALID))).toBe(false);
    expect(hasIssues(cannedResponseIssues({ ...VALID, body: '' }))).toBe(true);
  });
});
