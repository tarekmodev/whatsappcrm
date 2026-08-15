import { TENANT_ROLES, type TenantRole } from '@whatsappcrm/contracts';

/**
 * ⚠️ INTERIM STUB — REMOVE WHEN TAR-35 LANDS.
 *
 * Role resolution ultimately reads `GET /api/v1/auth/session`, which TAR-35
 * builds. Until then TAR-82 needs *some* role source to demonstrate the three
 * role-scoped views, so it reads one from a cookie.
 *
 * Two guards keep this from shipping as permanent:
 *   1. `webEnv.enableRoleStub` must be on, and it is off by default.
 *   2. `getSession()` refuses the stub in production regardless of the flag.
 *
 * Nothing here grants access. Every request the console makes is still enforced
 * server-side by the API's `PermissionGuard`; the stub only decides which
 * navigation and controls the browser renders.
 */

/** Distinct from TAR-35's `wac_session` so the two can never be confused. */
export const ROLE_STUB_COOKIE_NAME = 'wac_role_stub';

/**
 * The API's override for the cookie, and what a server-side call has to use.
 *
 * The cookie reaches the API on its own only on the **browser's** path, where the
 * rewrite in `next.config.mjs` forwards whatever the browser sent. Server
 * rendering and server actions run on the Next process, which sends no cookies of
 * its own — and while the stub is on there is no `wac_session` for
 * `sessionCookieHeaders` to carry either, so without this the request arrives
 * with no role at all and the API falls back to its default (`admin`). That is
 * TAR-366: the switcher moved the chrome and nothing else.
 *
 * Mirrors `ROLE_STUB_HEADER` in `apps/api/src/rbac/stub-principal.source.ts`,
 * which prefers the header over the cookie precisely so a non-browser caller can
 * say who it is. Both constants die with the stub.
 */
export const ROLE_STUB_HEADER = 'x-dev-role';

export const DEFAULT_STUB_ROLE: TenantRole = 'admin';

export function parseStubRole(value: string | undefined): TenantRole {
  return TENANT_ROLES.find((role) => role === value) ?? DEFAULT_STUB_ROLE;
}
