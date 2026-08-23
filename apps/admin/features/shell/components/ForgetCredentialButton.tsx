'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/ToastProvider';
import { content } from '~/content/en';
import { routes } from '~/lib/routes';
import { forgetCredentialAction } from '~/features/credential/credential.actions';

/**
 * Drops the operator's credential. In the bar at every width (spec §2.2), and it
 * is the reason that control exists: the token lives in a cookie this console
 * set, so there has to be one place to take it back.
 *
 * A client island for the pending state, and for the navigation — the action is a
 * cookie write with nothing to revoke server-side, so a `redirect` inside it
 * would make a one-line write untestable without a router.
 *
 * No confirmation: forgetting loses nothing, and presenting the token again
 * undoes it.
 */
export function ForgetCredentialButton() {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="sm"
      isPending={isPending}
      onClick={() => {
        startTransition(async () => {
          await forgetCredentialAction();
          showToast({ tone: 'success', message: content.credential.forgottenToast });
          router.replace(routes.credential());
          // Every screen renders on the server from the cookie just deleted, so
          // this navigation's cached payload is stale by definition.
          router.refresh();
        });
      }}
    >
      {content.credential.forget}
    </Button>
  );
}
