'use client';

import { useCallback, useMemo, useRef } from 'react';

/**
 * The `Idempotency-Key` a send carries, keyed on the draft it is for. Usage:
 *
 * ```tsx
 * const { keyFor, retire } = useIdempotencyKey();
 * // …
 * void sendMessageAction(conversationId, keyFor(JSON.stringify(input)), input);
 * // …and, once the send has landed:
 * retire();
 * ```
 *
 * The rule the API sets, and the reason this is not just `randomUUID()` at the
 * call site: **the same key with the same body replays the original send; the
 * same key with a *different* body is refused** as `idempotency_key_reused`. So
 * a key minted fresh on every click would let a double-click through as two
 * messages to the customer, and a key that never changed would block an agent
 * from fixing a typo and retrying after a failure.
 *
 * Keying on the payload gives both: identical submissions share a key and
 * deduplicate, an edited draft gets a new one. It survives a failed send, which
 * is the case that matters — a network drop the API in fact received is retried
 * onto the same key and answers with the message it already made.
 *
 * ## `retire` is not optional
 *
 * A key that has been *spent on a delivered message* must never be offered to a
 * new one. Two identical replies in a row — `ok`, then `ok` again, which is
 * ordinary support traffic — produce the same signature, and without this the
 * second send would reuse the first key, hit the API's replay path, and return
 * the *first* message with a 201. The console cannot tell that apart from a
 * successful send: the toast fires, the draft clears, and the customer receives
 * nothing. The API remembers a key for 24 hours, so the window for that is a
 * whole shift.
 *
 * So every caller clears the ledger the moment a send succeeds. Nothing else
 * clears it — a failure deliberately keeps the key, because retrying the same
 * draft onto it is exactly what idempotency is for.
 *
 * Refs rather than state: this must not re-render, and two clicks in the same
 * tick must read the same value.
 */

export interface IdempotencyKeys {
  /** The key for this exact payload, stable while the payload is. */
  keyFor: (signature: string) => string;
  /** Call on success. Forgets every key issued, so none can be replayed onto. */
  retire: () => void;
}

export function useIdempotencyKey(): IdempotencyKeys {
  const issued = useRef<{ signature: string; key: string } | null>(null);

  const keyFor = useCallback((signature: string) => {
    if (issued.current?.signature === signature) {
      return issued.current.key;
    }

    const key = crypto.randomUUID();

    issued.current = { signature, key };

    return key;
  }, []);

  const retire = useCallback(() => {
    issued.current = null;
  }, []);

  return useMemo(() => ({ keyFor, retire }), [keyFor, retire]);
}
