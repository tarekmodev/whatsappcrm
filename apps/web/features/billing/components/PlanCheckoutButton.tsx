'use client';

import { useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { startCheckoutAction } from '../billing.actions';
import { useHostedSession } from '../useHostedSession';
import { useCheckoutCoordination } from './CheckoutCoordinator';

/**
 * The control that moves the workspace onto a tier. Usage:
 * `<PlanCheckoutButton planKey="growth" planName="Growth" isCurrent={false} isSelectable />`.
 *
 * The only client component inside a plan card, and deliberately the smallest
 * thing that could be one: the card's copy, price formatting and feature list
 * are rendered on the server around it.
 *
 * **Its own state is never the reason it is disabled.** `isCurrent` and
 * `isSelectable` come from the API, which is holding the live usage that decides
 * them — a button greyed out from a count the console fetched a moment ago would
 * refuse a plan the API would have sold.
 *
 * **Unavailable is not the same as busy** (TAR-711). An unsellable tier takes
 * `isUnavailable`: the sunken ground rather than a dimmed accent, and
 * `aria-disabled` rather than the native attribute, so the control stays
 * reachable and the reason the card renders beneath it — pointed at by
 * `reasonId` — is actually announced to the reader who needs it. A natively
 * disabled button cannot be focused, which is how an explanation ends up on
 * screen for everybody except the people it was written for.
 *
 * While *another* tier's checkout is opening this one goes inert too, through
 * `CheckoutCoordinator`: two hosted sessions minted from one page means two
 * idempotency keys and a browser that leaves for whichever answers second.
 *
 * Failure renders **in place**, above the button, rather than as a toast. The
 * user is mid-purchase and looking at this card; a message that floats in over
 * the corner of the page and then leaves is the wrong shape for "your payment
 * page did not open, press it again".
 */
export function PlanCheckoutButton({
  planKey,
  planName,
  isCurrent,
  isSelectable,
  reasonId,
}: {
  planKey: string;
  planName: string;
  isCurrent: boolean;
  isSelectable: boolean;
  /** The card's line explaining why this tier cannot be chosen, when there is one. */
  reasonId?: string;
}) {
  const content = useContent();
  const perform = useCallback(() => startCheckoutAction(planKey), [planKey]);
  const { open, isPending, error, requestId } = useHostedSession({
    perform,
    failureMessage: content.billing.checkoutFailed,
  });
  const { openingPlanKey, report } = useCheckoutCoordination();

  useEffect(() => {
    report(planKey, isPending);
  }, [report, planKey, isPending]);

  if (isCurrent) {
    // Nothing to explain and nothing to press, so the native attribute is right:
    // there is no reason for a keyboard to stop here.
    return (
      <Button variant="secondary" isBlock disabled>
        {content.billing.currentPlanAction}
      </Button>
    );
  }

  const isBusyElsewhere = openingPlanKey !== null && openingPlanKey !== planKey;

  return (
    <Stack gap="3">
      <FormError message={error} requestId={requestId} />
      <Button
        variant="primary"
        isBlock
        isUnavailable={!isSelectable || isBusyElsewhere}
        aria-describedby={isSelectable ? undefined : reasonId}
        isPending={isPending}
        pendingLabel={content.billing.checkoutPending}
        onClick={open}
      >
        {content.billing.choosePlan(planName)}
      </Button>
    </Stack>
  );
}
