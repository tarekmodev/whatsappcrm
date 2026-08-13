'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/ui/ToastProvider';
import { useContent } from '@/lib/content';
import { acknowledgeSlaAlertAction, loadSlaAlertsAction } from '@/features/sla/sla.actions';
import type { SlaAlertView } from '@/features/sla/sla-alerts.data';

/**
 * The supervisor alert panel's whole data lifecycle: the read on open, the
 * acknowledgement, and the rollback when one fails.
 *
 * A discriminated union rather than three booleans, so "loading and failed" is
 * not a state anybody has to reason about — it is not representable.
 */

export type SlaAlertsState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly alerts: readonly SlaAlertView[];
      readonly hasMore: boolean;
    }
  | { readonly status: 'failed'; readonly message: string };

export interface UseSlaAlerts {
  readonly state: SlaAlertsState;
  /** Which row is being acknowledged, so the pending state lands on that button. */
  readonly pendingAlertId: string | null;
  readonly acknowledge: (alertId: string) => void;
  readonly retry: () => void;
}

/** What the panel reports back to the bell above it. */
export type SlaAlertCountListener = (count: number, hasMore: boolean) => void;

/**
 * @param onCountChange Called with the number of alerts still unacknowledged.
 *   It belongs to the *menu*, which outlives this panel: the panel unmounts when
 *   the popup closes, and a count kept here would snap back to the server's
 *   stale value every time somebody closed it after acknowledging something.
 *
 *   Held in a ref rather than depended on, because the menu re-creates the
 *   callback on every render and an effect that depended on it would refetch the
 *   list each time anything else in the shell re-rendered.
 */
export function useSlaAlerts(onCountChange: SlaAlertCountListener): UseSlaAlerts {
  const content = useContent();
  const { showToast } = useToast();
  const [state, setState] = useState<SlaAlertsState>({ status: 'loading' });
  const [pendingAlertId, setPendingAlertId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onCountChangeRef = useRef(onCountChange);
  // Acknowledging can outlive the panel — the popup closes on a click outside —
  // and a resolved promise writing into an unmounted tree would be a leak.
  const isMountedRef = useRef(true);

  useEffect(() => {
    onCountChangeRef.current = onCountChange;
  }, [onCountChange]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let isCurrent = true;

    setState({ status: 'loading' });

    void loadSlaAlertsAction().then((result) => {
      if (!isCurrent) {
        return;
      }

      if (result.status === 'error') {
        setState({ status: 'failed', message: result.message });
        return;
      }

      setState({ status: 'ready', alerts: result.data.alerts, hasMore: result.data.hasMore });
      onCountChangeRef.current(result.data.alerts.length, result.data.hasMore);
    });

    return () => {
      isCurrent = false;
    };
  }, [attempt]);

  const acknowledge = useCallback(
    (alertId: string) => {
      if (pendingAlertId !== null || state.status !== 'ready') {
        return;
      }

      const previous = state;
      const remaining = previous.alerts.filter((alert) => alert.id !== alertId);

      // Optimistic, and rolled back below on failure. Safe to retry because the
      // endpoint is idempotent: a second acknowledge returns the same row with
      // its original timestamp rather than a conflict.
      setPendingAlertId(alertId);
      setState({ status: 'ready', alerts: remaining, hasMore: previous.hasMore });
      onCountChangeRef.current(remaining.length, previous.hasMore);

      void acknowledgeSlaAlertAction(alertId)
        .then((result) => {
          if (!isMountedRef.current) {
            return;
          }

          if (result.status === 'error') {
            setState(previous);
            onCountChangeRef.current(previous.alerts.length, previous.hasMore);
            showToast({ tone: 'danger', message: result.message });
            return;
          }

          showToast({
            tone: 'success',
            message: content.sla.acknowledgeSuccess(
              content.tickets.reference(result.data.ticketNumber),
            ),
          });
        })
        .finally(() => {
          if (isMountedRef.current) {
            setPendingAlertId(null);
          }
        });
    },
    [content, pendingAlertId, showToast, state],
  );

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return { state, pendingAlertId, acknowledge, retry };
}
