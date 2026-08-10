/**
 * TAR-39's cursor encoding, in one place:
 *
 *   base64url(JSON.stringify({ v: 1, k: <sortValue>, id: <uuid> }))
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
 * The tie-breaker id is what makes the order total: two rows written in the same
 * millisecond are otherwise indistinguishable to a keyset predicate, and one of
 * them would be skipped at a page boundary.
 */

/** The only cursor version this build emits or accepts. */
const CURSOR_VERSION = 1;

export interface KeysetCursor {
  /** The row's value for the leading sort column, as it was serialised. */
  sortValue: string;
  /** The row's id — the tie-breaker that makes the sort total. */
  id: string;
}

export function encodeKeysetCursor({ sortValue, id }: KeysetCursor): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, k: sortValue, id }), 'utf8').toString(
    'base64url',
  );
}

/**
 * Returns `null` for anything this build cannot act on — malformed base64, JSON
 * that is not an object, a version it does not emit, a missing field.
 *
 * Null rather than a throw, and rather than a silent fall back to the first
 * page: the caller turns it into `validation_failed`, so a client that corrupted
 * a cursor is told so instead of quietly re-reading page one forever.
 */
export function decodeKeysetCursor(value: string): KeysetCursor | null {
  const parsed = parseJson(Buffer.from(value, 'base64url').toString('utf8'));

  if (parsed === null) {
    return null;
  }

  const { v, k, id } = parsed;

  return v === CURSOR_VERSION && typeof k === 'string' && typeof id === 'string'
    ? { sortValue: k, id }
    : null;
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
