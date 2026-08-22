'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { startCheckoutAction } from '../billing.actions';
import { useHostedSession } from '../useHostedSession';

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
 * refuse a plan the API would have sold. When it is disabled, the card above has
 * already said why in words: a control that silently will not press is not an
 * explanation.
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
}: {
  planKey: string;
  planName: string;
  isCurrent: boolean;
  isSelectable: boolean;
}) {
  const content = useContent();
  const perform = useCallback(() => startCheckoutAction(planKey), [planKey]);
  const { open, isPending, error, requestId } = useHostedSession({
    perform,
    failureMessage: content.billing.checkoutFailed,
  });

  if (isCurrent) {
    return (
      <Button variant="secondary" isBlock disabled>
        {content.billing.currentPlanAction}
      </Button>
    );
  }

  return (
    <Stack gap="3">
      <FormError message={error} requestId={requestId} />
      <Button
        variant="primary"
        isBlock
        disabled={!isSelectable}
        isPending={isPending}
        pendingLabel={content.billing.checkoutPending}
        onClick={open}
      >
        {content.billing.choosePlan(planName)}
      </Button>
    </Stack>
  );
}
