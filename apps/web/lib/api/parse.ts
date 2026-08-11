import type { CursorPage } from '@whatsappcrm/contracts';

/**
 * The shape of a contract schema, structurally. Typed this way rather than as
 * `ZodType` so `apps/web` needs no direct dependency on Zod: the contract's
 * exported schemas satisfy it, and so would a hand-written parser.
 */
export interface ResponseParser<T> {
  parse: (value: unknown) => T;
}

/**
 * Validates a `{ items, nextCursor }` list response against the item schema the
 * contract exports. Casting instead would let a contract drift reach a component
 * as a runtime crash somewhere far from the boundary.
 */
export function parseCursorPage<T>(
  itemParser: ResponseParser<T>,
  response: unknown,
): CursorPage<T> {
  if (typeof response !== 'object' || response === null) {
    throw new MalformedResponseError('Expected a list envelope object.');
  }

  const envelope = response as { items?: unknown; nextCursor?: unknown };

  if (!Array.isArray(envelope.items)) {
    throw new MalformedResponseError('Expected `items` to be an array.');
  }

  if (typeof envelope.nextCursor !== 'string' && envelope.nextCursor !== null) {
    throw new MalformedResponseError('Expected `nextCursor` to be a string or null.');
  }

  return {
    items: envelope.items.map((item) => itemParser.parse(item)),
    nextCursor: envelope.nextCursor,
  };
}

export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedResponseError';
  }
}
