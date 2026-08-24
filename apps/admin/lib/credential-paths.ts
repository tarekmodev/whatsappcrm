import { routes } from '~/lib/routes';

/**
 * Where the credential lives, and which screens are reachable without one.
 *
 * Deliberately **not** `server-only`: `proxy.ts` and the server-side guard both
 * import it, and one list is the only way the optimistic check and the
 * authoritative one cannot disagree. It holds no secret — only the cookie's
 * *name* and a route string already in the URL bar.
 */

/**
 * The operator's credential, as the browser holds it.
 *
 * `__Host-` prefixed, which this app can afford and `apps/web`'s admin routes
 * could not: the prefix requires `Path=/`, and here `/` **is** the whole app.
 * Nothing else is served from this origin, so a cookie on the root path reaches
 * only operator screens. The browser enforces the rest of the prefix's promise —
 * set over HTTPS, by this exact host, with no `Domain` — which is what stops a
 * sibling subdomain writing a credential into this console.
 *
 * The name is unprefixed on plain HTTP, because a `__Host-` cookie without
 * `Secure` is one the browser refuses outright — and local development is HTTP.
 * `apps/web`'s session cookie makes the same split for the same reason.
 *
 * ⚠️ **This is a bearer token at rest, not a session.** `PlatformAdminGuard`
 * authenticates a shared secret rather than an identity, so there is nothing to
 * revoke per browser and no expiry to shorten — stealing the cookie is stealing
 * the credential. It is a session cookie, so closing the browser ends it, and
 * rotating `PLATFORM_ADMIN_TOKEN` is what revokes one.
 */
export const CREDENTIAL_COOKIE_NAME_SECURE = '__Host-wac_operator';
export const CREDENTIAL_COOKIE_NAME = 'wac_operator';

/** Secure spelling first: it is the one every deployed environment uses. */
export const CREDENTIAL_COOKIE_NAMES = [
  CREDENTIAL_COOKIE_NAME_SECURE,
  CREDENTIAL_COOKIE_NAME,
] as const;

/**
 * The one screen reachable without a credential — the screen where the
 * credential is presented. Built from the route map rather than restated, so
 * renaming it cannot lock every operator out of the console.
 */
export function isCredentialPath(pathname: string): boolean {
  return pathname === routes.credential();
}
