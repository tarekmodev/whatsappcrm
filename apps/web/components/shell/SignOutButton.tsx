'use client';

import { useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { useContent } from '@/lib/content';
import { signOutAction } from '@/features/auth/session.actions';

/**
 * Ends the session. Usage: `<SignOutButton />`, in the app shell's utilities.
 *
 * A client island for one reason: the pending state. The action revokes the session
 * on the API before it redirects, so there is a real wait, and a button that looks
 * inert during it invites a second press.
 *
 * No confirmation dialog: signing out loses nothing and signing back in undoes it,
 * so the guidance on destructive actions does not apply.
 */
export function SignOutButton() {
  const content = useContent();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="sm"
      isPending={isPending}
      onClick={() => {
        startTransition(async () => {
          await signOutAction();
        });
      }}
    >
      {content.auth.signOut}
    </Button>
  );
}
