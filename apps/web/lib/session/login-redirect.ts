import 'server-only';

import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { parseRedirectPath, routes } from '@/lib/routes';
import { REQUEST_PATH_HEADER } from '@/lib/session/session-paths';

/**
 * Sends the caller to sign in, keeping where they were trying to go.
 *
 * The single exit for "there is no usable session here", so the answer cannot
 * differ between the shell, a page, a data read and an action. Returns `never` —
 * `redirect` throws — which is what lets callers write
 * `return session ?? redirectToLogin()`.
 *
 * `replace` rather than `push`: the page they were bounced off is not somewhere
 * the back button should return them to, because it would bounce them again.
 *
 * ⚠️ `redirect` throws a framework-controlled error, so this must be called
 * **outside** a `try` block, or the `catch` will swallow the navigation and leave
 * the user sitting on a page that is no longer theirs. Where a caller cannot
 * avoid the `try` — a server action that maps every failure to an inline
 * message — it rethrows with `unstable_rethrow` instead.
 */
export async function redirectToLogin(): Promise<never> {
  redirect(routes.login({ redirectTo: await intendedPath() }), RedirectType.replace);
}

/**
 * Where the user was heading, from the header `proxy.ts` set.
 *
 * Empty when the proxy did not run — a server action reached from a route outside
 * its matcher, say — and `routes.login` drops an empty parameter, so sign-in
 * falls back to its own landing page instead of this module inventing a second
 * answer to that question.
 *
 * Narrowed through `parseRedirectPath` even though the proxy wrote it: it is a
 * request header, and an open redirect is not worth trusting one for.
 */
async function intendedPath(): Promise<string> {
  const requestPath = (await headers()).get(REQUEST_PATH_HEADER);

  return parseRedirectPath(requestPath ?? undefined, '');
}
