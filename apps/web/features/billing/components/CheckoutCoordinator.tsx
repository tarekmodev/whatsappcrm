'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import styles from './CheckoutCoordinator.module.css';

/**
 * Keeps one checkout in flight at a time across a grid of plan cards. Usage:
 * `<CheckoutCoordinator busyNote={…}>{cards}</CheckoutCoordinator>`.
 *
 * Each tier's control is its own client island, so without something holding
 * them together a second tier can be pressed while the first is still minting a
 * session — two checkouts, two idempotency keys, and a browser that leaves for
 * whichever provider page answers second. `useHostedSession` already refuses a
 * *second click on the same button*; this is the same rule across siblings.
 *
 * **The note is rendered here, not inside the pending card**, and that is the
 * point of putting it in the grid's footer: the browser is on its way to another
 * origin and the wait needs explaining, but growing one card's control region
 * mid-press would push every card in that row down. It is a polite live region,
 * so it is announced once rather than read by whoever happens to tab past it.
 *
 * The default outside a provider is no coordination at all, which is what a
 * single card rendered on its own in a test should get.
 */

export interface CheckoutCoordination {
  /** The tier whose hosted session is being minted, or `null`. */
  readonly openingPlanKey: string | null;
  readonly report: (planKey: string, isOpening: boolean) => void;
}

const CheckoutCoordinationContext = createContext<CheckoutCoordination>({
  openingPlanKey: null,
  report: () => {
    // No provider, no siblings to coordinate with. Not an error.
  },
});

export function CheckoutCoordinator({
  busyNote,
  children,
}: {
  /** What the wait is for, once a checkout is opening. */
  busyNote: string;
  children: ReactNode;
}) {
  const [openingPlanKey, setOpeningPlanKey] = useState<string | null>(null);

  const report = useCallback((planKey: string, isOpening: boolean) => {
    setOpeningPlanKey((current) => {
      if (isOpening) {
        return planKey;
      }

      // Only the tier that claimed it may release it: a card re-rendering after
      // somebody else has taken over must not clear the state under them.
      return current === planKey ? null : current;
    });
  }, []);

  const value = useMemo(() => ({ openingPlanKey, report }), [openingPlanKey, report]);

  return (
    <CheckoutCoordinationContext.Provider value={value}>
      {children}
      {openingPlanKey === null ? null : (
        <p role="status" className={styles.note}>
          {busyNote}
        </p>
      )}
    </CheckoutCoordinationContext.Provider>
  );
}

export function useCheckoutCoordination(): CheckoutCoordination {
  return useContext(CheckoutCoordinationContext);
}
