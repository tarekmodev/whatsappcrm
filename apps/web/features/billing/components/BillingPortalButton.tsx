'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { openBillingPortalAction } from '../billing.actions';
import { useHostedSession } from '../useHostedSession';

/**
 * The way out to the provider's own customer portal — invoices, payment method,
 * plan change and cancellation, all four in one place. Usage:
 * `<BillingPortalButton />`.
 *
 * A button rather than a link, and that is not a styling choice: a portal session
 * is minted on the click and lives for minutes, so there is no URL to put in an
 * `href` when the page renders. A link that had one would be dead by the time
 * anybody pressed it, and would leak a session token into the browser history
 * and into every "copy link address" on the page.
 *
 * The portal is where cancellation happens, which is why nothing in this console
 * cancels a subscription itself: the provider owns the confirmation, the
 * effective date and the receipt. Re-implementing it here would mean two places
 * that can end a subscription and one of them without a record.
 */
export function BillingPortalButton() {
  const content = useContent();
  const perform = useCallback(() => openBillingPortalAction(), []);
  const { open, isPending, error, requestId } = useHostedSession({
    perform,
    failureMessage: content.billing.portalFailed,
  });

  return (
    <Stack gap="3">
      <FormError message={error} requestId={requestId} />
      <Button
        variant="secondary"
        isPending={isPending}
        pendingLabel={content.billing.portalPending}
        onClick={open}
      >
        {content.billing.portalAction}
      </Button>
    </Stack>
  );
}
