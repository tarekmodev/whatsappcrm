import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor';

/**
 * The half of pagination that has no database in it: what the encoding
 * round-trips, and — more importantly — everything it refuses. A cursor arrives
 * from the network, so every case below is reachable input rather than a
 * hypothetical.
 */

const CURSOR = {
  sortValue: '2026-08-10T09:00:00.000Z',
  id: '50444444-4444-7444-8444-444444444401',
};

describe('keyset cursor', () => {
  it('round-trips a cursor', () => {
    expect(decodeKeysetCursor(encodeKeysetCursor(CURSOR))).toEqual(CURSOR);
  });

  it('encodes to base64url, so it survives a query string unescaped', () => {
    expect(encodeKeysetCursor(CURSOR)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a cursor from a version this build does not emit', () => {
    const nextVersion = Buffer.from(
      JSON.stringify({ v: 2, k: CURSOR.sortValue, id: CURSOR.id }),
      'utf8',
    ).toString('base64url');

    expect(decodeKeysetCursor(nextVersion)).toBeNull();
  });

  it.each([
    ['not base64 at all', 'not a cursor!!'],
    ['base64 of something that is not JSON', Buffer.from('nope', 'utf8').toString('base64url')],
    ['JSON that is not an object', Buffer.from('[1,2,3]', 'utf8').toString('base64url')],
    ['an object missing its id', Buffer.from('{"v":1,"k":"x"}', 'utf8').toString('base64url')],
    [
      'an object missing its sort value',
      Buffer.from('{"v":1,"id":"x"}', 'utf8').toString('base64url'),
    ],
    [
      'an id that is not a string',
      Buffer.from('{"v":1,"k":"x","id":7}', 'utf8').toString('base64url'),
    ],
    ['an empty string', ''],
  ])('refuses %s', (_case, value) => {
    expect(decodeKeysetCursor(value)).toBeNull();
  });
});
