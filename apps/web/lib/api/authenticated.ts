import 'server-only';

import { apiRequest, type ApiRequest } from '@/lib/api/http';
import { isSessionExpiredError } from '@/lib/api/session-expiry';
import { sessionCookieHeaders } from '@/lib/session/session-cookie';
import { verifySession } from '@/lib/session/session';
import { redirectToLogin } from '@/lib/session/login-redirect';

/**
 * The transport every API call that needs a principal goes through, and the reason
 * the guard cannot be forgotten.
 *
 * It does three things a resource module should not each have to remember:
 *
 *   1. **Verifies the session first.** Next's own guidance is that the check
 *      belongs next to the data rather than in a layout, because a layout does not
 *      re-render on client navigation and does not control whether the segments
 *      below it render. Putting it here means any read or write, from any page or
 *      action, is guarded by construction. `getSession` is request-cached, so this
 *      costs one round-trip per render pass, not one per call.
 *   2. **Forwards the caller's cookie.** Server rendering and server actions run
 *      on the Next process, not in the browser, so `credentials: 'include'` does
 *      nothing there: a call that omits this is anonymous to the API and comes
 *      back 401. Tenant scoping is derived from this cookie by the API's guard —
 *      never from an id this process could pass.
 *   3. **Turns a lost session into a redirect.** The session can be revoked
 *      between the check and the call — an admin deactivating the account, or a
 *      password reset revoking every session — and that answer is a sign-in, not
 *      an error page.
 *
 * Unauthenticated endpoints — the password-reset request and confirm, which are
 * reachable by definition without a session — stay on `apiRequest` directly.
 */
export async function authenticatedRequest(request: ApiRequest): Promise<unknown> {
  await verifySession();

  const outcome = await attempt(request);

  // Outside the `try`, per Next's rule for `redirect`: inside it, the navigation
  // it throws would be caught as though it were a failed request.
  return outcome.status === 'ok' ? outcome.value : redirectToLogin();
}

type Outcome = { readonly status: 'ok'; readonly value: unknown } | { readonly status: 'expired' };

async function attempt(request: ApiRequest): Promise<Outcome> {
  try {
    return {
      status: 'ok',
      value: await apiRequest({
        ...request,
        // The caller's own headers win: `sessionCookieHeaders` is the default, not
        // an override, so a call that needs to say something else still can.
        headers: { ...(await sessionCookieHeaders()), ...request.headers },
      }),
    };
  } catch (error) {
    if (isSessionExpiredError(error)) {
      return { status: 'expired' };
    }

    // Everything else belongs to the caller: a 403, a 409 and a 502 all need
    // different copy, and swallowing them here would flatten the difference.
    throw error;
  }
}
