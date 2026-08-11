'use server';

import { revalidatePath } from 'next/cache';
import { redirect, unstable_rethrow } from 'next/navigation';
import { logout } from '@/lib/api/auth';
import { routes } from '@/lib/routes';
import { clearSessionCookie } from '@/lib/session/session-cookie';
import { verifySession } from '@/lib/session/session';

/**
 * Sign out (TAR-62). The other half of the guard: the guard decides when a session
 * has gone, and this is how a person chooses to end one.
 *
 * Order matters. Revoke server-side **first**, then clear the browser's copy: a
 * cookie cleared before the revocation would leave a live session in the API's
 * table that nothing can reach to end — which is exactly what "signed out" must
 * not quietly mean.
 *
 * Gated by no permission, and never should be: there is no role that should be
 * unable to leave.
 */
export async function signOutAction(): Promise<void> {
  // Not `getSession`: with no session there is nothing to revoke, and the redirect
  // this throws is the answer anyway.
  await verifySession();

  await revokeSession();
  await clearSessionCookie();

  // Every page renders from the principal, so the whole tree is stale — including
  // whatever the client router cached for a back-navigation.
  revalidatePath('/', 'layout');

  // Outside any `try`, per Next's rule for `redirect`.
  redirect(routes.login());
}

/**
 * A failed revocation still ends the session **here**. The alternative is an error
 * screen that leaves the person signed in on a shared machine because the API was
 * briefly unreachable; the server-side session then lapses on its own idle timeout
 * (`AUTH_POLICY.sessionIdleMs`).
 *
 * Not swallowed — the log line is what tells an operator that logouts are failing.
 */
async function revokeSession(): Promise<void> {
  try {
    await logout({ allSessions: false });
  } catch (error) {
    // First, per the `unstable_rethrow` contract: the session can have been
    // revoked underneath us, and `authenticatedRequest` answers that with a
    // navigation, which is not this function's error to handle.
    unstable_rethrow(error);

    console.error('Sign-out revocation failed; clearing the local session anyway', error);
  }
}
