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
 *   2. `resolveSession()` refuses the stub in production regardless of the flag.
 *
 * Nothing here grants access. Every request the console makes is still enforced
 * server-side by the API's `PermissionGuard`; the stub only decides which
 * navigation and controls the browser renders.
 */

/** Distinct from TAR-35's `wac_session` so the two can never be confused. */
export const ROLE_STUB_COOKIE_NAME = 'wac_role_stub';

export const DEFAULT_STUB_ROLE: TenantRole = 'admin';

export function parseStubRole(value: string | undefined): TenantRole {
  return TENANT_ROLES.find((role) => role === value) ?? DEFAULT_STUB_ROLE;
}
