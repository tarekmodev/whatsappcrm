'use client';

import { useCallback, useRef, useState } from 'react';
import type { ActionResult } from '@/lib/actions/result';

/**
 * Mints a provider-hosted session and sends the browser to it. Usage:
 *
 * ```tsx
 * const { open, isPending, error, requestId } = useHostedSession({
 *   perform: () => startCheckoutAction(planKey),
 *   failureMessage: content.billing.checkoutFailed,
 * });
 * ```
 *
 * Extracted because checkout and the customer portal need the identical
 * sequence, and because the four rules that are easy to get wrong belong in one
 * place rather than in two buttons:
 *
 *   1. **Never double-open.** A second click while the first request is in
 *      flight would mint a second session — and on the checkout path, a second
 *      idempotency key. The guard is a ref rather than the state value, because
 *      two clicks in the same tick would both read `isPending === false`.
 *   2. **Stay pending through the navigation.** `isPending` is deliberately
 *      *not* cleared on success: a full page load to another origin takes a
 *      moment, and a button that springs back to "Choose Growth" in the gap
 *      invites the click that opens a second checkout.
 *   3. **Never navigate to something that failed.** The action returns a result
 *      rather than throwing, and only a `success` produces a navigation. The URL
 *      it carries has already been parsed against `HostedSessionSchema`, which
 *      refuses anything that is not http(s) — the guard that matters on the one
 *      link a user is most primed to follow without reading.
 *   4. **`assign`, not `replace`.** The console stays in history, so the browser
 *      Back button brings somebody who changed their mind on the provider's page
 *      back to the plans rather than out of the app.
 *
 * `useActionForm` was the alternative and is the wrong shape: it is built around
 * a form that stays mounted, keeps its values and clears its pending state, and
 * every one of those is a property this flow does not want.
 */

export interface UseHostedSessionOptions {
  perform: () => Promise<ActionResult<{ url: string }>>;
  /** Shown when the action itself could not run — a dropped network, a dead chunk. */
  failureMessage: string;
}

export interface UseHostedSession {
  open: () => void;
  isPending: boolean;
  /** Rendered in place, next to the control. `null` when there is nothing wrong. */
  error: string | null;
  requestId: string | null;
}

export function useHostedSession({
  perform,
  failureMessage,
}: UseHostedSessionOptions): UseHostedSession {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const open = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    setIsPending(true);
    setError(null);
    setRequestId(null);

    void perform()
      .then((result) => {
        if (result.status === 'error') {
          inFlightRef.current = false;
          setIsPending(false);
          setError(result.message);
          setRequestId(result.requestId);
          return;
        }

        // Left pending on purpose — see rule 2 above. The page is leaving.
        window.location.assign(result.data.url);
      })
      .catch((caught: unknown) => {
        // Reaches here only if the action failed to run at all. Not swallowed.
        console.error('Opening a hosted billing session failed', caught);
        inFlightRef.current = false;
        setIsPending(false);
        setError(failureMessage);
      });
  }, [perform, failureMessage]);

  return { open, isPending, error, requestId };
}
