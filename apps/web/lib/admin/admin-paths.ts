import { routes } from '@/lib/routes';

/**
 * Which paths belong to the platform-operator console, which of them an operator
 * with no credential may still open, and what the credential is stored under.
 *
 * Deliberately **not** `server-only`, for the same reason `session-paths.ts` is
 * not: `proxy.ts` and the server-side guard both import it, and one list is the
 * only way the optimistic check and the authoritative one cannot disagree about
 * what "admin" means. It holds no secret — only the cookie's *name* and route
 * strings that are already in the URL bar.
 */

/**
 * The operator's credential, as the browser holds it.
 *
 * Three properties, and each is load-bearing:
 *
 *   * **`httpOnly`** — no script in the console ever reads it. The value is the
 *     platform's `PLATFORM_ADMIN_TOKEN` entry, which authenticates every tenant
 *     on the deployment; a value the browser can read is one an injected script
 *     can post somewhere.
 *   * **`Path=/admin`** — so the browser does not attach it to `/api/*`, which
 *     `next.config.mjs` rewrites straight to the API host. The token travels to
 *     the API exactly once per call, as an `Authorization` header written by this
 *     process, and never as a cookie riding along on a tenant's request.
 *   * **`SameSite=Strict`** — an operator surface has no cross-site entry point.
 *
 * The path scoping is also why the name carries no `__Host-` prefix: that prefix
 * requires `Path=/`, and shipping the platform credential to every request in the
 * app is the larger of the two risks.
 *
 * ⚠️ **This is a bearer token at rest in a cookie, not a session.** The API's
 * `PlatformAdminGuard` authenticates a shared secret rather than an identity, so
 * there is nothing to revoke per browser and no expiry to shorten — stealing the
 * cookie is stealing the credential. `docs/reference/platform-admin-console.md`
 * states the exposure and names the follow-up (a real platform-admin identity
 * with a session, which `platform-admin.guard.ts` itself already flags).
 */
export const PLATFORM_ADMIN_COOKIE_NAME = 'wac_platform_admin';

/** The prefix every operator route sits under, and the cookie's `Path`. */
export const ADMIN_PATH_PREFIX = '/admin';

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PATH_PREFIX || pathname.startsWith(`${ADMIN_PATH_PREFIX}/`);
}

/**
 * The one operator screen reachable without a credential — the screen where the
 * credential is presented. Built from the route map rather than restated, so
 * renaming it cannot lock every operator out of the console.
 */
export function isAdminPublicPath(pathname: string): boolean {
  return pathname === routes.adminSignIn();
}
