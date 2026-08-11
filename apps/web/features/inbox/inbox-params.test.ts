import { describe, expect, it } from 'vitest';
import { parseInboxParams } from './inbox-params';

/**
 * The URL is untrusted. Every value is narrowed against the contract's own
 * schema, so a hand-edited or truncated link falls back to the default view
 * rather than reaching a fetch as a malformed query.
 */
describe('parseInboxParams', () => {
  const CONVERSATION_ID = '0192f004-0000-7000-8000-000000000401';

  it('reads a complete inbox URL', () => {
    expect(
      parseInboxParams({
        scope: 'unassigned',
        status: 'pending',
        conversationId: CONVERSATION_ID,
      }),
    ).toEqual({ scope: 'unassigned', status: 'pending', conversationId: CONVERSATION_ID });
  });

  it('defaults to the agent’s own work with no filters', () => {
    expect(
      parseInboxParams({ scope: undefined, status: undefined, conversationId: undefined }),
    ).toEqual({ scope: 'assigned', status: undefined, conversationId: null });
  });

  it('falls back rather than passing a scope or status the contract rejects', () => {
    expect(
      parseInboxParams({ scope: 'everything', status: 'archived', conversationId: undefined }),
    ).toEqual({ scope: 'assigned', status: undefined, conversationId: null });
  });

  it('drops a conversation id that is not an id', () => {
    // A truncated link deserves the list, not an error card: the API answers 422
    // for a path parameter that is not a UUID.
    expect(
      parseInboxParams({ scope: undefined, status: undefined, conversationId: '0192f004-0000' }),
    ).toMatchObject({ conversationId: null });
  });
});
