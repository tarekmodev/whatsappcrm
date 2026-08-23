import 'server-only';

import { cookies, headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { webEnv } from '@/lib/config/env';
import { routes, parseRedirectPath } from '@/lib/routes';
import { REQUEST_PATH_HEADER } from '@/lib/session/session-paths';
import { ADMIN_PATH_PREFIX, PLATFORM_ADMIN_COOKIE_NAME } from '@/lib/admin/admin-paths';

/**
 * The platform operator's credential: where it is kept, and the gate every
 * operator screen and every operator action goes through.
 *
 * The console has no *session* to resolve, and that is a property of the API
 * rather than a shortcut taken here. `PlatformAdminGuard` authenticates a shared
 * bearer token from `PLATFORM_ADMIN_TOKEN` — the operator is not a user inside
 * any tenant, so TAR-35's session lookup and TAR-22's per-tenant roles have
 * nothing to resolve them against, and provisioning has to work before the first
 * tenant exists. There is therefore nothing for this module to exchange the
 * token for: holding it *is* being authenticated.
 *
 * What this module does own is keeping it out of the browser. The token is read
 * from a form once, verified against the API, and put in an `httpOnly` cookie
 * scoped to `/admin`; from then on it is read here, on the server, and attached
 * as an `Authorization` header by `lib/api/admin.ts`. No component receives it,
 * no client bundle contains it, and it is never returned by an action.
 */

/**
 * The credential this request carries, or `null`.
 *
 * Not cached: `cookies()` is already request-scoped, and a `cache()` around a
 * secret is one more place it can be read from.
 */
export async function readPlatformCredential(): Promise<string | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(PLATFORM_ADMIN_COOKIE_NAME)?.value.trim() ?? '';

  return value.length === 0 ? null : value;
}

/**
 * The gate. Returns the credential, or sends the operator to sign in.
 *
 * Called by every operator page and every operator action rather than by the
 * layout, on the same reasoning `lib/api/authenticated.ts` gives for the tenant
 * console: a layout does not re-render on client navigation and does not decide
 * whether the segments below it render, so the check that matters is the one
 * next to the data. `proxy.ts`'s cookie-presence check is the optimistic half
 * and proves nothing about validity.
 */
export async function requirePlatformCredential(): Promise<string> {
  return (await readPlatformCredential()) ?? (await redirectToAdminSignIn());
}

/**
 * Sends the operator to the credential form, carrying where they were heading.
 *
 * The single exit for "there is no usable credential here", so the answer cannot
 * differ between a page, a read and an action. Returns `never` — `redirect`
 * throws — which is what lets callers write
 * `(await readPlatformCredential()) ?? (await redirectToAdminSignIn())`.
 *
 * `replace`, matching `redirectToLogin`: the screen they were bounced off is not
 * somewhere the back button should return them to, because it would bounce them
 * again.
 *
 * ⚠️ Must be called **outside** a `try`, or the `catch` swallows the navigation.
 * An action that maps every failure to an inline message rethrows it with
 * `unstable_rethrow` instead — which `runAdminAction` does.
 */
export async function redirectToAdminSignIn(): Promise<never> {
  redirect(routes.adminSignIn({ redirectTo: await adminRequestPath() }), RedirectType.replace);
}

/**
 * Where the operator was when they were turned away, narrowed to a path inside
 * the console.
 *
 * `parseRedirectPath` first, on the reasoning `login-redirect.ts` gives: the
 * header is written by the proxy, and an open redirect is not worth trusting one
 * for. The second narrowing is this module's own — a `?next=` that leaves
 * `/admin` would take an operator, after presenting a *platform* credential, to a
 * tenant screen their credential does not authenticate them for.
 */
async function adminRequestPath(): Promise<string> {
  const requested = (await headers()).get(REQUEST_PATH_HEADER) ?? undefined;
  const path = parseRedirectPath(requested, routes.adminTenants());

  return path.startsWith(ADMIN_PATH_PREFIX) ? path : routes.adminTenants();
}

/**
 * Stores a credential the API has just accepted.
 *
 * `secure` follows the deployment rather than being hardcoded, for the reason
 * `session-cookie.ts` documents about the session cookie's two spellings: local
 * development is plain HTTP, and a `Secure` cookie there is one the browser
 * silently drops — which would present as a sign-in that appears to succeed and
 * lands back on the form.
 *
 * No `maxAge`: a session cookie, so closing the browser ends the operator's
 * access to the console. The token itself has no expiry, so the browser's own
 * lifetime is the only bound available.
 */
export async function storePlatformCredential(credential: string): Promise<void> {
  const cookieStore = await cookies();

  cookieStore.set(PLATFORM_ADMIN_COOKIE_NAME, credential, {
    httpOnly: true,
    sameSite: 'strict',
    secure: webEnv.isProduction,
    path: ADMIN_PATH_PREFIX,
  });
}

export async function clearPlatformCredential(): Promise<void> {
  const cookieStore = await cookies();

  // The path has to match the one it was set with, or the delete addresses a
  // different cookie and the operator stays signed in.
  cookieStore.delete({ name: PLATFORM_ADMIN_COOKIE_NAME, path: ADMIN_PATH_PREFIX });
}
