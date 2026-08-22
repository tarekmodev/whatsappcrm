import { describe, expect, it } from 'vitest';
import { isTicketQueueFiltered, parseTicketId, parseTicketQueueParams } from './ticket-params';

/**
 * The queue's URL is untrusted input. A hand-edited or truncated one has to land
 * on the default view rather than reach a fetch as a malformed query, so every
 * value is narrowed against the contract's own schema.
 */

const VALID_ID = '0192f00a-0000-7000-8000-000000000a01';

describe('parseTicketQueueParams', () => {
  it('defaults to the active queue, assigned to me', () => {
    expect(
      parseTicketQueueParams({
        scope: undefined,
        status: undefined,
        priority: undefined,
        overdue: undefined,
      }),
    ).toEqual({
      scope: 'assigned',
      status: undefined,
      priority: undefined,
      isOverdueOnly: false,
    });
  });

  it('keeps every value the contract publishes', () => {
    expect(
      parseTicketQueueParams({
        scope: 'all',
        status: 'resolved',
        priority: 'urgent',
        overdue: 'true',
      }),
    ).toEqual({
      scope: 'all',
      status: 'resolved',
      priority: 'urgent',
      isOverdueOnly: true,
    });
  });

  it('drops a value the contract does not publish rather than erroring', () => {
    // The alternative is an error card for a link somebody truncated, or a 422
    // from the API for a query the console built out of a hand-edited URL.
    expect(
      parseTicketQueueParams({
        scope: 'everything',
        status: 'archived',
        priority: 'critical',
        overdue: 'yes',
      }),
    ).toEqual({
      scope: 'assigned',
      status: undefined,
      priority: undefined,
      isOverdueOnly: false,
    });
  });

  it('reads `?overdue=false` as the full queue, not as an empty one', () => {
    // `z.coerce.boolean()` would make this `true` — every non-empty string is.
    // A truncated link must not silently hide every ticket that is on time.
    expect(
      parseTicketQueueParams({
        scope: undefined,
        status: undefined,
        priority: undefined,
        overdue: 'false',
      }).isOverdueOnly,
    ).toBe(false);
  });
});

describe('isTicketQueueFiltered', () => {
  const DEFAULT_VIEW = parseTicketQueueParams({
    scope: undefined,
    status: undefined,
    priority: undefined,
    overdue: undefined,
  });

  it('is false for the view an unparameterised arrival lands on', () => {
    expect(isTicketQueueFiltered(DEFAULT_VIEW)).toBe(false);
  });

  it('is true for every narrowing the bar can apply', () => {
    expect(isTicketQueueFiltered({ ...DEFAULT_VIEW, scope: 'all' })).toBe(true);
    expect(isTicketQueueFiltered({ ...DEFAULT_VIEW, status: 'closed' })).toBe(true);
    expect(isTicketQueueFiltered({ ...DEFAULT_VIEW, priority: 'high' })).toBe(true);
    expect(isTicketQueueFiltered({ ...DEFAULT_VIEW, isOverdueOnly: true })).toBe(true);
  });
});

describe('parseTicketId', () => {
  it('accepts a well-formed id', () => {
    expect(parseTicketId(VALID_ID)).toBe(VALID_ID);
  });

  it('rejects anything that is not one, so the API is never asked a 422', () => {
    expect(parseTicketId('not-an-id')).toBeNull();
    expect(parseTicketId('')).toBeNull();
    expect(parseTicketId(undefined)).toBeNull();
  });
});
