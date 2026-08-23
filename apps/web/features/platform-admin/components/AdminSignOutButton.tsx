'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/ToastProvider';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { signOutOfPlatformConsoleAction } from '../platform-admin.actions';

/**
 * Drops the operator's credential. Usage: `<AdminSignOutButton />`, in the
 * operator console's utilities.
 *
 * `SignOutButton`'s counterpart rather than a reuse of it, because the two end
 * different things: that one revokes a *session* on the API and lets the action's
 * own redirect carry the user out, and this one deletes a cookie holding a shared
 * token the API knows nothing about. There is no round trip to revoke and nothing
 * server-side to invalidate — rotating `PLATFORM_ADMIN_TOKEN` is what revokes a
 * platform credential.
 *
 * The navigation is here rather than in the action for that same reason: with
 * nothing to revoke, the action is a cookie write, and a `redirect` inside it
 * would make a one-line write untestable without a router.
 *
 * No confirmation: signing out loses nothing, and presenting the token again
 * undoes it.
 */
export function AdminSignOutButton() {
  const content = useContent();
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
          await signOutOfPlatformConsoleAction();
          showToast({ tone: 'success', message: content.platformAdmin.signIn.signedOutToast });
          router.replace(routes.adminSignIn());
          // Every operator screen renders on the server from the cookie the
          // action just deleted, so this navigation's cached payload is stale by
          // definition.
          router.refresh();
        });
      }}
    >
      {content.platformAdmin.signIn.signOut}
    </Button>
  );
}
