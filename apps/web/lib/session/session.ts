import 'server-only';

import { cache } from 'react';
import {
  SessionResponseSchema,
  type Permission,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { apiRequest } from '@/lib/api/http';
import { isSessionExpiredError } from '@/lib/api/session-expiry';
import { sessionCookieHeaders } from '@/lib/session/session-cookie';
import { redirectToLogin } from '@/lib/session/login-redirect';
import { resolveStubPrincipal } from '@/lib/session/stub-principal';
import { checkerForPrincipal, type PermissionChecker } from '@/lib/session/permissions';

/**
 * Session resolution — the authoritative half of the route guard, and the only
 * place the console decides who the caller is. Server-only: `server-only` turns an
 * accidental import from a client component into a build error rather than a
 * leaked principal.
 *
 * **The API is the source of truth.** Tenant, role and permissions come from
 * `GET /api/v1/auth/session`, resolved from the httpOnly session cookie by the
 * API's own guard. Nothing is inferred from the cookie's presence, nothing is
 * cached in the browser, and no client-supplied tenant or role is ever consulted —
 * which is also why a deactivated or logged-out session shows up here on the very
 * next request rather than whenever some cached copy expires.
 *
 * Two sources, chosen by configuration:
 *   - Real: `GET /api/v1/auth/session`, which TAR-35 builds.
 *   - Stub: a cookie-backed role, so TAR-82's three role-scoped views can be
 *     built and reviewed before TAR-35 lands. See `role-stub.ts`.
 */

export interface ResolvedSession {
  readonly principal: SessionPrincipal;
  readonly checker: PermissionChecker;
  /** True while the principal comes from the TAR-35 stub rather than a real session. */
  readonly isStubbed: boolean;
}

const SESSION_ENDPOINT = '/v1/auth/session';

/**
 * The caller's session, or `null` when they have none.
 *
 * `cache` deduplicates per request: the shell, the navigation, the page and every
 * authenticated read need the principal, and none of them should cost a second
 * round-trip. It memoises per render pass only — a revoked session is never
 * carried across requests.
 *
 * Prefer `verifySession` unless you genuinely have something to render for a
 * signed-out visitor; a `null` that nobody acts on is how a guard goes missing.
 */
export const getSession = cache(async (): Promise<ResolvedSession | null> => {
  if (webEnv.enableRoleStub) {
    if (webEnv.isProduction) {
      // Belt and braces: the flag defaults to off, and even when set it must
      // never fabricate a principal in production.
      throw new Error(
        'NEXT_PUBLIC_ENABLE_ROLE_STUB must not be enabled in production. Wire TAR-35 sessions instead.',
      );
    }

    const principal = await resolveStubPrincipal();

    return { principal, checker: checkerForPrincipal(principal), isStubbed: true };
  }

  const response = await readSession();

  if (response === null) {
    return null;
  }

  const principal = SessionResponseSchema.parse(response).user;

  return { principal, checker: checkerForPrincipal(principal), isStubbed: false };
});

/**
 * The session, or a redirect to sign in. Every route below `app/(app)` reaches
 * this, and so does every authenticated API call — see `lib/api/authenticated.ts`
 * for why the check belongs next to the data and not only in the layout.
 */
export async function verifySession(): Promise<ResolvedSession> {
  return (await getSession()) ?? redirectToLogin();
}

/**
 * Server-side gate for a route. Returns the session when the principal holds the
 * permission and `null` when it does not, so the caller can render a real 403
 * state instead of a redirect that hides what happened.
 *
 * A caller with no session at all is redirected to sign in rather than shown that
 * state: "you do not have access" is the wrong answer for someone who has not had
 * the chance to say who they are.
 *
 * This is UX, not enforcement — the API refuses the same request regardless.
 */
export async function requirePermission(permission: Permission): Promise<ResolvedSession | null> {
  const session = await verifySession();

  return session.checker.can(permission) ? session : null;
}

export async function requireAnyPermission(
  permissions: readonly Permission[],
): Promise<ResolvedSession | null> {
  const session = await verifySession();

  return session.checker.canAny(permissions) ? session : null;
}

/**
 * For a server action: throws rather than returning `null`, because an action
 * that has already been invoked has no 403 page to render into.
 */
export async function assertPermission(permission: Permission): Promise<ResolvedSession> {
  const session = await verifySession();

  if (!session.checker.can(permission)) {
    throw new PermissionDeniedError(permission);
  }

  return session;
}

export class PermissionDeniedError extends Error {
  readonly permission: Permission;

  constructor(permission: Permission) {
    super(`Missing permission ${permission}`);
    this.name = 'PermissionDeniedError';
    this.permission = permission;
  }
}

/**
 * `null` for "the API says nobody", every other failure rethrown.
 *
 * The distinction matters: an unreachable API must surface as an error the user
 * can retry, not as a sign-out. Redirecting on a 502 would log everybody out
 * whenever the API restarted, and they would have no way to tell why.
 */
async function readSession(): Promise<unknown> {
  try {
    return await apiRequest({
      method: 'GET',
      path: SESSION_ENDPOINT,
      // The API authenticates by cookie; forward the one the browser sent us.
      headers: await sessionCookieHeaders(),
    });
  } catch (error) {
    if (isSessionExpiredError(error)) {
      return null;
    }

    throw error;
  }
}
