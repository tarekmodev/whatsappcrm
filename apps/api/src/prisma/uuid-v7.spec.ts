import { uuidV7 } from './uuid-v7';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV7', () => {
  it('is a well-formed v7 uuid', () => {
    // The version nibble and the variant bits are what Postgres and every uuid
    // parser check; getting either wrong produces a string that still looks like
    // a uuid and is rejected on insert.
    expect(uuidV7()).toMatch(UUID_SHAPE);
  });

  it('encodes the timestamp it was given, big-endian, in the first six bytes', () => {
    const at = new Date('2026-08-11T09:41:00.123Z');

    const timestamp = uuidV7(at).replace(/-/g, '').slice(0, 12);

    expect(parseInt(timestamp, 16)).toBe(at.getTime());
  });

  it('sorts by time, which is the whole reason it is not v4', () => {
    // The property every `(<timestamp> DESC, id DESC)` keyset index depends on:
    // ids written later compare greater as plain strings.
    const earlier = uuidV7(new Date('2026-08-11T09:00:00.000Z'));
    const later = uuidV7(new Date('2026-08-11T09:00:00.001Z'));

    expect(earlier < later).toBe(true);
  });

  it('does not repeat itself within a millisecond', () => {
    const at = new Date('2026-08-11T09:41:00.000Z');

    const ids = new Set(Array.from({ length: 1_000 }, () => uuidV7(at)));

    expect(ids.size).toBe(1_000);
  });
});
