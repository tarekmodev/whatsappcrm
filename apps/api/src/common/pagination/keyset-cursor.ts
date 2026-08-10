import { IdSchema } from '@whatsappcrm/contracts';

/**
 * TAR-39's cursor encoding, in one place:
 *
 *   base64url(JSON.stringify({ v: 1, k: [<sortValue>, ...], id: <uuid> }))
 *
 * Keyset, never `OFFSET`. An offset page duplicates and skips rows in a feed
 * that is being appended to while it is read, which is every list in this
 * product.
 *
 * Two properties the shape is chosen for:
 *
 *   * **Opaque to clients.** Base64url of JSON is decodable by anyone who cares
 *     to, and that is fine — it carries no secret, only a sort value and an id
 *     the caller has already been shown. What it must not be is *meaningful*, so
 *     nothing here is documented to a client and every field is validated on the
 *     way back in rather than trusted.
 *   * **Versioned.** `v` exists so a future change of sort key can reject an
 *     in-flight cursor from the old shape instead of silently paging from the
 *     wrong place.
 *
 * `k` is **always an array**, one entry per sort column in declared order, with
 * the id as the final tie-breaker — `[lastMessageAt]` for the inbox,
 * `[name, language]` for a two-column sort. An array even at length one, so that
 * adding a second sort column to a list later is not a cursor format change
 * (0002, cursor encoding).
 *
 * The tie-breaker id is what makes the order total: two rows written in the same
 * millisecond are otherwise indistinguishable to a keyset predicate, and one of
 * them would be skipped at a page boundary. For a composite key the same is true
 * of every column before the last — comparing only the leading column and the id
 * drops every row that shares that column's value with the page boundary and
 * sorts before it by id, silently and with no error anywhere.
 */

/** The only cursor version this build emits or accepts. */
const CURSOR_VERSION = 1;

export interface KeysetCursor {
  /** The row's values for the sort columns, in declared order, as serialised. */
  sortValues: string[];
  /** The row's id — the tie-breaker that makes the sort total. */
  id: string;
}

export function encodeKeysetCursor({ sortValues, id }: KeysetCursor): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, k: sortValues, id }), 'utf8').toString(
    'base64url',
  );
}

/**
 * Returns `null` for anything this build cannot act on — malformed base64, JSON
 * that is not an object, a version it does not emit, a missing field, a `k` that
 * is not an array of strings, an `id` that is not a uuid.
 *
 * Null rather than a throw, and rather than a silent fall back to the first
 * page: the caller turns it into `validation_failed`, so a client that corrupted
 * a cursor is told so instead of quietly re-reading page one forever. A caller
 * that expects a particular arity checks `sortValues.length` itself — a cursor
 * from a list with a different sort key decodes cleanly and is still wrong.
 *
 * The id is checked as a uuid and not merely as a string because it is the one
 * field that reaches a query as a value rather than as a bound: every id column
 * here is `@db.Uuid`, and a non-uuid is rejected by the driver rather than
 * filtered on — a 500 for input that every other malformed cursor answers with
 * `validation_failed`. Checked here rather than per list, so no list can inherit
 * the gap.
 */
export function decodeKeysetCursor(value: string): KeysetCursor | null {
  const parsed = parseJson(Buffer.from(value, 'base64url').toString('utf8'));

  if (parsed === null) {
    return null;
  }

  const { v, k, id } = parsed;
  const cursorId = IdSchema.safeParse(id);

  return v === CURSOR_VERSION && isStringArray(k) && cursorId.success
    ? { sortValues: k, id: cursorId.data }
    : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Cursors arrive from the network, so a parse failure is expected input, not a fault. */
function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);

    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
