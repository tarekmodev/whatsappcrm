import { describe, expect, it } from 'vitest';
import { parseContactId, parseContactListParams } from './contact-params';

/**
 * The URL is untrusted. A hand-edited or truncated parameter falls back to the
 * default view rather than reaching the API as a malformed query — the same rule
 * the ticket queue follows.
 */

const CONTACT_ID = '0192f003-0000-7000-8000-000000000301';

describe('parseContactListParams', () => {
  it('passes a real search term and tag through', () => {
    expect(parseContactListParams({ q: 'fatima', tag: CONTACT_ID })).toEqual({
      q: 'fatima',
      tagId: CONTACT_ID,
    });
  });

  it('is the unfiltered view when nothing is named', () => {
    expect(parseContactListParams({ q: undefined, tag: undefined })).toEqual({
      q: undefined,
      tagId: undefined,
    });
  });

  it('drops a tag that is not an id rather than sending it to the API', () => {
    expect(parseContactListParams({ q: undefined, tag: 'vip' }).tagId).toBeUndefined();
  });

  it('drops a search term longer than the contract allows', () => {
    expect(parseContactListParams({ q: 'a'.repeat(200), tag: undefined }).q).toBeUndefined();
  });
});

describe('parseContactId', () => {
  it('accepts a well-formed id', () => {
    expect(parseContactId(CONTACT_ID)).toBe(CONTACT_ID);
  });

  it('answers null for a segment that names no contact', () => {
    // A truncated link. Answered with the same state a contact in another tenant
    // gets, rather than a 422 from the API or an error card.
    expect(parseContactId('0192f003-0000')).toBeNull();
    expect(parseContactId(undefined)).toBeNull();
  });
});
