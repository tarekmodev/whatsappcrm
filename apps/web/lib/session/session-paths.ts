import { routes } from '@/lib/routes';

/**
 * Which paths are reachable without a session, and how `proxy.ts` tells a server
 * render which path it is on.
 *
 * Deliberately **not** `server-only`: `proxy.ts` and the server-side guard both
 * import it, and one list is the only way the optimistic check and the
 * authoritative one cannot disagree about what "public" means. It contains no
 * principal and no secret — only route strings that are already in the URL bar.
 *
 * The list is built from the route map rather than restated, so renaming a screen
 * cannot leave a signed-out visitor locked out of it.
 */

/**
 * Set by the proxy on every matched request so a server render — which has no
 * `usePathname` — can name the page the user was denied and put it in `?next=`.
 * Prefixed rather than the conventional `x-pathname` because an untrusted
 * upstream header of that name is plausible; this one the proxy always overwrites.
 */
export const REQUEST_PATH_HEADER = 'x-wac-request-path';

/**
 * Every screen someone with no session must still be able to open: sign-in
 * itself, the invitation they have not accepted yet, the two password-recovery
 * screens they reach precisely because they cannot sign in, and the two
 * self-signup screens.
 *
 * The signup pair is the strongest case on the list rather than the weakest: a
 * visitor there has no session **and no tenant**, so a guard that bounced them
 * to `/login` would send them to a sign-in form for an account that does not
 * exist yet — the exact dead end TAR-805 exists to close.
 */
const PUBLIC_PATHS: readonly string[] = [
  routes.login(),
  routes.invite(),
  routes.signup(),
  routes.verifySignup(),
  routes.forgotPassword(),
  routes.resetPassword(),
];

/**
 * Prefix matching, not equality: a public screen that later grows a child route
 * stays public. `pathname` comes from the request, so it carries no query string.
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
