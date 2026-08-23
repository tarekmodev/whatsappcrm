import 'server-only';

import { cookies, headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { webEnv } from '@/lib/config/env';
import { REQUEST_PATH_HEADER } from '@/lib/session/session-paths';
import { parseRedirectPath, routes } from '~/lib/routes';
import {
  CREDENTIAL_COOKIE_NAME,
  CREDENTIAL_COOKIE_NAMES,
  CREDENTIAL_COOKIE_NAME_SECURE,
} from '~/lib/credential-paths';

/**
 * The operator's credential: where it is kept, and how a screen asks for it.
 *
 * There is no *session* to resolve, and that is a property of the API rather
 * than a shortcut. `PlatformAdminGuard` authenticates a shared bearer token from
 * `PLATFORM_ADMIN_TOKEN` — the operator is not a user inside any tenant, so
 * TAR-35's session lookup and TAR-22's roles have nothing to resolve them
 * against, and provisioning has to work before the first tenant exists. Holding
 * the token *is* being authenticated.
 *
 * What this module owns is keeping it out of the browser: read from a form once,
 * verified against the API, put in an `httpOnly` cookie, and read back **here,
 * on the server**, for every call. No component receives it, no client bundle
 * contains it, and no server action returns it.
 */

/** The credential this request carries, or `null`. */
export async function readCredential(): Promise<string | null> {
  const cookieStore = await cookies();

  for (const name of CREDENTIAL_COOKIE_NAMES) {
    const value = cookieStore.get(name)?.value.trim() ?? '';

    if (value.length > 0) {
      return value;
    }
  }

  return null;
}

/**
 * The gate. Returns the credential, or sends the operator to the door.
 *
 * Called by every screen and every action rather than by the layout, on the
 * reasoning `apps/web`'s `authenticatedRequest` gives: a layout does not
 * re-render on client navigation and does not decide whether the segments below
 * it render, so the check that matters is the one next to the data.
 *
 * **Absence only.** A credential the API has since *refused* is a different
 * event and must not redirect — see `CredentialRefusedError` below.
 */
export async function requireCredential(): Promise<string> {
  return (await readCredential()) ?? (await redirectToCredentialScreen());
}

/**
 * Sends the operator to the credential screen, carrying where they were heading.
 *
 * `replace`, because the screen they were bounced off is not somewhere the back
 * button should return them to — it would bounce them again.
 *
 * ⚠️ Must be called **outside** a `try`, or the `catch` swallows the navigation.
 */
export async function redirectToCredentialScreen(): Promise<never> {
  redirect(routes.signIn({ redirectTo: await intendedPath() }), RedirectType.replace);
}

/**
 * Where the operator was, from the header `proxy.ts` set. Narrowed even though
 * the proxy wrote it: it is a request header, and an open redirect is not worth
 * trusting one for.
 */
async function intendedPath(): Promise<string> {
  const requested = (await headers()).get(REQUEST_PATH_HEADER) ?? undefined;

  return parseRedirectPath(requested, routes.tenants());
}

/**
 * The API refused the credential this request carried.
 *
 * Its own type because the console's answer to it is **not** a redirect. The
 * ordinary cause is the token being rotated under an operator mid-incident, and
 * bouncing them silently to the front door leaves them wondering what they did;
 * 0002 spec §2.2 rules that every screen says so instead, with one action back.
 * `attemptRead` turns this into that state.
 */
export class CredentialRefusedError extends Error {
  constructor() {
    super('The platform admin credential was refused.');
    this.name = 'CredentialRefusedError';
  }
}

/**
 * Stores a credential the API has just accepted.
 *
 * `secure` follows the deployment rather than being hardcoded, and the cookie's
 * *name* follows it too — a `__Host-` cookie without `Secure` is one the browser
 * drops outright, which would present as a sign-in that appears to succeed and
 * lands back on the form. Local development is plain HTTP.
 *
 * No `maxAge`: a session cookie, so closing the browser ends the operator's
 * access from that machine. The token itself has no expiry, so the browser's own
 * lifetime is the only bound available.
 */
export async function storeCredential(credential: string): Promise<void> {
  const cookieStore = await cookies();

  cookieStore.set(credentialCookieName(), credential, {
    httpOnly: true,
    sameSite: 'strict',
    secure: webEnv.isProduction,
    path: '/',
  });
}

/** Drops it. Both spellings, because deleting one that was never set is a no-op. */
export async function forgetCredential(): Promise<void> {
  const cookieStore = await cookies();

  for (const name of CREDENTIAL_COOKIE_NAMES) {
    cookieStore.delete({ name, path: '/' });
  }
}

function credentialCookieName(): string {
  return webEnv.isProduction ? CREDENTIAL_COOKIE_NAME_SECURE : CREDENTIAL_COOKIE_NAME;
}
