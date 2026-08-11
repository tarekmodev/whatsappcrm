'use client';

import { useCallback, useRef } from 'react';

/**
 * The `Idempotency-Key` a send carries, keyed on the draft it is for. Usage:
 *
 * ```tsx
 * const keyFor = useIdempotencyKey();
 * void sendMessageAction(conversationId, keyFor(JSON.stringify(input)), input);
 * ```
 *
 * The rule the API sets, and the reason this is not just `randomUUID()` at the
 * call site: **the same key with the same body replays the original send; the
 * same key with a *different* body is refused** as `idempotency_key_reused`. So
 * a key that never changed would block an agent from fixing a typo and retrying
 * after a failure, and a key minted fresh on every click would let a
 * double-click through as two messages to the customer.
 *
 * Keying on the payload gives both: identical submissions share a key and
 * deduplicate, an edited draft gets a new one. It survives a failed send, which
 * is the case that matters — a network drop that the API in fact received is
 * retried onto the same key and answers with the message it already made.
 *
 * A ref rather than state: this must not re-render, and two clicks in the same
 * tick must read the same value.
 */
export function useIdempotencyKey(): (signature: string) => string {
  const issued = useRef<{ signature: string; key: string } | null>(null);

  return useCallback((signature: string) => {
    if (issued.current?.signature === signature) {
      return issued.current.key;
    }

    const key = crypto.randomUUID();

    issued.current = { signature, key };

    return key;
  }, []);
}
