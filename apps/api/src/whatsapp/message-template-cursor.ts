import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetCursor,
} from '../common/pagination/keyset-cursor';
import type { Prisma } from '../generated/prisma/client';

/**
 * The `(name ASC, language ASC, id ASC)` keyset, shared by both template lists.
 *
 * Amendment 1 rules this ordering for the composer's picker, and amendment 8
 * keeps it for the administration surface deliberately: the two lists put the
 * same template in the same place, so an administrator comparing "what an agent
 * sees" against "what we hold" is not also reconciling two sort orders. One
 * ordering means one cursor, and a cursor is only correct in the company of the
 * order it was issued for — leaving each list to build its own would be two
 * chances to get the same predicate wrong.
 */

/** The cursor as these queries use it: the row's position in `(name, language, id)`. */
export interface MessageTemplateCursor {
  name: string;
  language: string;
  id: string;
}

/** Raised for a cursor this build cannot act on. A controller turns it into `validation_failed`. */
export class InvalidCursorError extends Error {
  constructor() {
    super('The cursor is not valid. Start from the first page.');
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * A cursor whose sort key is not the `[name, language]` pair this ordering emits
 * is rejected here rather than passed on. Prisma would refuse an `undefined`
 * comparison too, but as a 500 — and a corrupted cursor is bad input, not a
 * fault. The arity check is also what rejects a cursor issued by the superseded
 * `created_at DESC` ordering: it decodes cleanly and carries one value.
 */
export function readMessageTemplateCursor(value: string | undefined): MessageTemplateCursor | null {
  if (value === undefined) {
    return null;
  }

  const cursor: KeysetCursor | null = decodeKeysetCursor(value);
  const [name, language, ...rest] = cursor?.sortValues ?? [];

  if (cursor === null || name === undefined || language === undefined || rest.length > 0) {
    throw new InvalidCursorError();
  }

  return { name, language, id: cursor.id };
}

/** The cursor for the last row *read*, which is where the next page resumes. */
export function encodeMessageTemplateCursor(row: MessageTemplateCursor): string {
  return encodeKeysetCursor({ sortValues: [row.name, row.language], id: row.id });
}

/**
 * "Strictly after the cursor row in `(name ASC, language ASC, id ASC)` order",
 * in the shape 0002 rules for a resume predicate: an inclusive bound on the
 * leading column — `name >= $1`, written where the query is built — minus the
 * part of that name's tie group this caller has already been given.
 *
 * The obvious translation is the nested disjunction
 * `name > $1 OR (name = $1 AND (language > $2 OR (language = $2 AND id > $3)))`.
 * It returns the same rows and is the wrong shape: a planner cannot turn a
 * nested OR into one index start condition, so it scans the range from the
 * beginning and filters — the `OFFSET` cost profile keyset pagination exists to
 * avoid. The bound below is a start condition, and the `NOT` discards only the
 * rows sharing the cursor's name, of which a template list holds a handful.
 */
export function alreadyReturned(cursor: MessageTemplateCursor): Prisma.MessageTemplateWhereInput {
  return {
    name: cursor.name,
    OR: [
      { language: { lt: cursor.language } },
      { language: cursor.language, id: { lte: cursor.id } },
    ],
  };
}
