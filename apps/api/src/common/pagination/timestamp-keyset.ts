import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor';

/**
 * The `(timestamp, id)` keyset, in one place.
 *
 * Three of this product's lists sort that way — the inbox on `last_message_at`,
 * a thread on `sent_at`, a conversation's notes on `created_at` — and the
 * predicate 0002 rules for them is the same shape every time, with one
 * genuinely subtle half. Written once, because the failure mode of a second
 * copy is silent: a page that quietly drops one row of a tie group, or a cursor
 * that never advances.
 */

export interface TimestampCursor {
  /** The sort column's value on the last row of the previous page. */
  readonly at: Date;
  /** That row's id — the tie-breaker that makes the order total. */
  readonly id: string;
}

/**
 * Three outcomes rather than `TimestampCursor | null`, because "the caller sent
 * no cursor" and "the caller sent one this build cannot read" are different
 * facts: the first is page one, the second is `validation_failed`. Collapsing
 * them means a client that corrupted a cursor quietly re-reads page one for
 * ever.
 */
export type TimestampCursorResult =
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'cursor'; readonly cursor: TimestampCursor };

const ABSENT: TimestampCursorResult = { outcome: 'absent' };
const INVALID: TimestampCursorResult = { outcome: 'invalid' };

export function encodeTimestampCursor({ at, id }: TimestampCursor): string {
  return encodeKeysetCursor({ sortValues: [at.toISOString()], id });
}

/**
 * A cursor of a different arity — one issued by a two-column sort, or by a
 * future ordering — decodes cleanly and is still wrong, so the length is
 * checked here rather than being discovered as a Prisma `undefined` comparison
 * and a 500.
 */
export function readTimestampCursor(value: string | undefined): TimestampCursorResult {
  if (value === undefined) {
    return ABSENT;
  }

  const decoded = decodeKeysetCursor(value);
  const [at, ...rest] = decoded?.sortValues ?? [];

  if (decoded === null || at === undefined || rest.length > 0) {
    return INVALID;
  }

  const parsed = new Date(at);

  return Number.isNaN(parsed.getTime())
    ? INVALID
    : { outcome: 'cursor', cursor: { at: parsed, id: decoded.id } };
}

/**
 * The two halves of "strictly after the cursor row", for a caller to compose
 * against its own sort column:
 *
 * ```ts
 * where: {
 *   sentAt: resume.bound,
 *   NOT: { sentAt: cursor.at, ...resume.exclude },
 * }
 * ```
 *
 * `bound` is an **inclusive** comparison on the leading column, which is what a
 * btree index leading with it can serve as a start condition — the scan begins
 * at the cursor and reads forward `LIMIT` rows. `exclude` subtracts the part of
 * that timestamp's tie group the caller has already been given.
 *
 * The obvious alternative, `at < $1 OR (at = $1 AND id < $2)`, returns exactly
 * the same rows and is the wrong shape: a planner cannot turn a nested OR into
 * one index start condition, so it scans the range from the beginning and
 * filters — the `OFFSET` cost profile keyset pagination exists to avoid, on the
 * two hottest queries in this product. And the shorter `(at, id) < ($1, $2)`
 * written as a plain conjunction is not merely slower but **wrong**: it drops
 * every row sharing the boundary's timestamp whose id sorts before it, with no
 * error anywhere.
 *
 * Both directions are supported because a thread reads newest-first by default
 * and oldest-first for an export (`MessageListQuery.order`), and an export that
 * silently lost a row would be the worst place to discover a hand-written
 * predicate.
 */
export function resumeAfter(cursor: TimestampCursor, direction: 'asc' | 'desc'): TimestampResume {
  return direction === 'desc'
    ? { bound: { lte: cursor.at }, exclude: { id: { gte: cursor.id } } }
    : { bound: { gte: cursor.at }, exclude: { id: { lte: cursor.id } } };
}

export interface TimestampResume {
  readonly bound: { readonly lte: Date } | { readonly gte: Date };
  readonly exclude: { readonly id: { readonly gte: string } | { readonly lte: string } };
}
