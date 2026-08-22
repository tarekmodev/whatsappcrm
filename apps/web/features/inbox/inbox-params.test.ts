import { describe, expect, it } from 'vitest';
import { parseInboxParams } from './inbox-params';

/**
 * The URL is untrusted. Every value is narrowed against the contract's own
 * schema, so a hand-edited or truncated link falls back to the default view
 * rather than reaching a fetch as a malformed query.
 */
describe('parseInboxParams', () => {
  const CONVERSATION_ID = '0192f004-0000-7000-8000-000000000401';
  const NOTHING = {
    scope: undefined,
    status: undefined,
    conversationId: undefined,
    q: undefined,
    sort: undefined,
  };

  it('reads a complete inbox URL', () => {
    expect(
      parseInboxParams({
        scope: 'unassigned',
        status: 'pending',
        conversationId: CONVERSATION_ID,
        q: 'invoice',
        sort: 'oldest',
      }),
    ).toEqual({
      scope: 'unassigned',
      status: 'pending',
      conversationId: CONVERSATION_ID,
      q: 'invoice',
      sort: 'oldest',
    });
  });

  it('defaults to the agent’s own work with no filters', () => {
    expect(parseInboxParams(NOTHING)).toEqual({
      scope: 'assigned',
      status: undefined,
      conversationId: null,
      q: undefined,
      sort: 'newest',
    });
  });

  it('falls back rather than passing a scope or status the contract rejects', () => {
    expect(parseInboxParams({ ...NOTHING, scope: 'everything', status: 'archived' })).toEqual({
      scope: 'assigned',
      status: undefined,
      conversationId: null,
      q: undefined,
      sort: 'newest',
    });
  });

  it('drops a conversation id that is not an id', () => {
    // A truncated link deserves the list, not an error card: the API answers 422
    // for a path parameter that is not a UUID.
    expect(parseInboxParams({ ...NOTHING, conversationId: '0192f004-0000' })).toMatchObject({
      conversationId: null,
    });
  });

  it('trims a search term and drops one that is only spaces', () => {
    // `?q=` with nothing in it is what an empty submitted field produces, and
    // the contract's minimum is one character — so it is no search at all.
    expect(parseInboxParams({ ...NOTHING, q: '  invoice  ' })).toMatchObject({ q: 'invoice' });
    expect(parseInboxParams({ ...NOTHING, q: '   ' })).toMatchObject({ q: undefined });
  });

  it('drops a search term longer than the contract accepts', () => {
    // 120 characters is the schema's cap; a longer one is answered 422, and the
    // unfiltered list is a better answer than an error card.
    expect(parseInboxParams({ ...NOTHING, q: 'a'.repeat(121) })).toMatchObject({ q: undefined });
  });

  it('falls back to the default order rather than one the API cannot serve', () => {
    // The sort control always has a value to show and the list always has one to
    // send, so a hand-edited `?sort=alphabetical` is the default view — never an
    // undefined the column header would have to branch on.
    expect(parseInboxParams({ ...NOTHING, sort: 'alphabetical' })).toMatchObject({
      sort: 'newest',
    });
  });
});
