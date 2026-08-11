import { createHash } from 'node:crypto';

/**
 * What "the same request" means for `Idempotency-Key`, written once.
 *
 * The stored `request_hash` is what decides between replaying a stored response
 * and answering `idempotency_key_reused`, so getting its inputs wrong is not a
 * hashing detail — it is either two messages to a customer or a false 409 on a
 * legitimate retry.
 *
 * Three things go in, and each of them is load-bearing:
 *
 *   * **the operation** — a key is a client's, and nothing stops the same one
 *     being presented to a send and to a billing checkout. Both would otherwise
 *     hash the same empty-ish body and replay each other's response.
 *   * **the target** — the same body sent to two different conversations is two
 *     different requests, and answering the second with the first's stored
 *     message would silently drop a reply.
 *   * **the payload** — the request body as the contract's schema parsed it,
 *     not the raw bytes. Unknown keys have already been stripped and defaults
 *     applied, so a client that adds a field the API ignores does not get a 409
 *     for a request that is, to this API, identical.
 *
 * ## Keys are sorted, recursively
 *
 * `JSON.stringify` preserves insertion order, so `{"type":"text","body":"hi"}`
 * and `{"body":"hi","type":"text"}` would hash differently — and a client
 * retrying through a different serialiser, a proxy that re-encodes, or simply a
 * second render of the same object would be told its key was reused. Sorting
 * makes the hash a function of the *value*, which is what the contract means by
 * "the same body".
 *
 * Arrays are **not** sorted: order is meaning there. `variables: ['a','b']` is a
 * different template render from `['b','a']`.
 */
export function hashIdempotentRequest(input: {
  operation: string;
  target: string;
  payload: unknown;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operation: input.operation,
        target: input.target,
        payload: canonicalise(input.payload),
      }),
    )
    .digest('hex');
}

/**
 * The value with every object's keys in a fixed order.
 *
 * `undefined` survives as `undefined` and is dropped by `JSON.stringify` in
 * both the original and the canonical form, so an optional field left out and
 * one set to `undefined` hash alike — which is what a caller means by them.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalise(entry)]));
}
