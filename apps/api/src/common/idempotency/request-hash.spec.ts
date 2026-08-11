import { hashIdempotentRequest } from './request-hash';

/**
 * What counts as "the same request".
 *
 * Both directions matter and fail differently. Hashing two genuinely identical
 * requests differently means a legitimate retry is refused with
 * `idempotency_key_reused`. Hashing two different requests the same means a
 * client is told a message was sent that was not — the worse of the two, and the
 * reason the operation and the target are inputs at all.
 */

const BASE = {
  operation: 'conversation.send',
  target: '68444444-4444-7444-8444-4444444444c1',
  payload: { type: 'text', body: 'hello' },
};

describe('hashIdempotentRequest', () => {
  it('is stable for the same request', () => {
    expect(hashIdempotentRequest(BASE)).toBe(hashIdempotentRequest(BASE));
  });

  it('ignores the order the body was serialised in', () => {
    // A retry rendered by a different serialiser, or simply a second render of
    // the same object, must not read as a different request.
    expect(hashIdempotentRequest({ ...BASE, payload: { body: 'hello', type: 'text' } })).toBe(
      hashIdempotentRequest(BASE),
    );
  });

  it('ignores key order inside a nested object', () => {
    const header = { format: 'location', latitude: 1, longitude: 2 };
    const reversed = { longitude: 2, latitude: 1, format: 'location' };

    expect(hashIdempotentRequest({ ...BASE, payload: { header } })).toBe(
      hashIdempotentRequest({ ...BASE, payload: { header: reversed } }),
    );
  });

  it('distinguishes a different body', () => {
    expect(hashIdempotentRequest({ ...BASE, payload: { type: 'text', body: 'goodbye' } })).not.toBe(
      hashIdempotentRequest(BASE),
    );
  });

  it('distinguishes the same body sent to another conversation', () => {
    // Otherwise one key would replay a reply into the wrong thread, and the
    // second customer would silently receive nothing.
    expect(
      hashIdempotentRequest({ ...BASE, target: '68444444-4444-7444-8444-4444444444c2' }),
    ).not.toBe(hashIdempotentRequest(BASE));
  });

  it('distinguishes the same body on another operation', () => {
    // A key is the client's, and nothing stops it being presented to a send and
    // to a billing checkout.
    expect(hashIdempotentRequest({ ...BASE, operation: 'billing.checkout' })).not.toBe(
      hashIdempotentRequest(BASE),
    );
  });

  it('keeps array order significant', () => {
    // `variables` is positional: two orders are two different template renders.
    expect(hashIdempotentRequest({ ...BASE, payload: { variables: ['a', 'b'] } })).not.toBe(
      hashIdempotentRequest({ ...BASE, payload: { variables: ['b', 'a'] } }),
    );
  });
});
