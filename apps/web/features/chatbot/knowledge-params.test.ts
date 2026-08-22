import { describe, expect, it } from 'vitest';
import { parseKnowledgeListParams } from './knowledge-params';

/**
 * The URL is untrusted. A hand-edited or truncated parameter falls back to the
 * unfiltered knowledge base rather than reaching the API as a malformed query —
 * the same rule the contact directory follows.
 */
describe('parseKnowledgeListParams', () => {
  it('passes a real search term and status through', () => {
    expect(parseKnowledgeListParams({ q: 'returns', status: 'failed' })).toEqual({
      q: 'returns',
      status: 'failed',
    });
  });

  it('is the unfiltered view when nothing is named', () => {
    expect(parseKnowledgeListParams({ q: undefined, status: undefined })).toEqual({
      q: undefined,
      status: undefined,
    });
  });

  it('drops a status the contract does not name', () => {
    expect(parseKnowledgeListParams({ q: undefined, status: 'archived' }).status).toBeUndefined();
  });

  it('drops a search term longer than the contract allows', () => {
    expect(parseKnowledgeListParams({ q: 'a'.repeat(200), status: undefined }).q).toBeUndefined();
  });

  it('trims the term, so one search is one URL', () => {
    expect(parseKnowledgeListParams({ q: '  returns  ', status: undefined }).q).toBe('returns');
  });

  it('reads a term that is only whitespace as no filter at all', () => {
    expect(parseKnowledgeListParams({ q: '   ', status: undefined }).q).toBeUndefined();
  });
});
