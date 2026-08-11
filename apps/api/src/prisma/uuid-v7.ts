import { randomBytes } from 'node:crypto';

/**
 * The id Prisma would have generated, for the writes Prisma cannot express.
 *
 * Every model carries `@default(uuid(7))`, which is a **client-side** default:
 * Postgres 17 has no native `uuidv7()`, so the generated SQL has no column
 * default and anything inserting outside the Prisma client has to supply the id
 * itself (schema conventions, rule 5). `TicketLinker`'s create path is a raw
 * `INSERT … ON CONFLICT … DO NOTHING` against a partial index — a statement the
 * client has no way to build — so it is the first production path that needs
 * this.
 *
 * `gen_random_uuid()` in the statement would have been shorter and is what the
 * fixtures use, but it is v4: random, so it sorts arbitrarily. Ids are the
 * tie-breaker in every `(<timestamp> DESC, id DESC)` keyset index in this schema,
 * and a v4 id there scatters inserts across the index instead of appending to it.
 *
 * Layout is RFC 9562 §5.7: 48-bit big-endian Unix milliseconds, then 74 random
 * bits with the version and variant nibbles overwritten.
 *
 * `randomBytes` rather than `Math.random`: these ids are handed to clients, and
 * a predictable id is an enumeration surface.
 */
export function uuidV7(at: Date = new Date()): string {
  const bytes = randomBytes(16);

  bytes.writeUIntBE(at.getTime(), 0, 6);
  // Version 7 in the high nibble of byte 6, RFC 9562 variant in the top two bits
  // of byte 8. Written through the accessors rather than by index because
  // `noUncheckedIndexedAccess` types a byte read as `number | undefined`.
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);

  const hex = bytes.toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
