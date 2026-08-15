import 'server-only';

import { permissionsForRole, type SessionPrincipal, type TenantRole } from '@whatsappcrm/contracts';
import { MOCK_STUB_USER_IDS, MOCK_TENANT_ID, MOCK_USERS } from '@/lib/api/mock/fixtures';
import { readStubRole } from '@/lib/session/role-stub-request';

/**
 * ⚠️ INTERIM STUB (TAR-35) — see `role-stub.ts` for why this exists and what
 * removes it.
 *
 * Kept in its own module so both `session.ts` (which publishes the principal to
 * the app) and the mock transport's handlers (which scope fixture data by it) can
 * read it without importing each other.
 *
 * The role comes from `role-stub-request.ts`, the same reader the transport uses
 * to name the role on a real API call — one cookie read, so the principal the
 * chrome shows and the principal the API resolves cannot disagree (TAR-366).
 */

/** Literals, not generated values: a fresh id per render would break hydration. */
const STUB_SESSION_ID = '0192f0ff-0000-7000-8000-0000000000ff';
const STUB_SESSION_EXPIRES_AT = '2026-12-31T23:59:59.000Z';

export async function resolveStubPrincipal(): Promise<SessionPrincipal> {
  return buildStubPrincipal(await readStubRole());
}

/**
 * Permissions are materialised from the role through the contract's own
 * `permissionsForRole`, so the stub cannot disagree with what the API grants.
 */
export function buildStubPrincipal(role: TenantRole): SessionPrincipal {
  const userId = MOCK_STUB_USER_IDS[role];
  const user = MOCK_USERS.find((candidate) => candidate.id === userId);

  if (user === undefined) {
    throw new Error(`Missing stub fixture user for role ${role}.`);
  }

  return {
    userId: user.id,
    tenantId: MOCK_TENANT_ID,
    email: user.email,
    displayName: user.displayName,
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [...user.teamIds],
    sessionId: STUB_SESSION_ID,
    expiresAt: STUB_SESSION_EXPIRES_AT,
  };
}
