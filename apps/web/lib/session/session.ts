import 'server-only';

import { cache } from 'react';
import { cookies } from 'next/headers';
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_SECURE,
  SessionResponseSchema,
  type Permission,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { apiRequest } from '@/lib/api/http';
import { resolveStubPrincipal } from '@/lib/session/stub-principal';
import { checkerForPrincipal, type PermissionChecker } from '@/lib/session/permissions';

/**
 * Session resolution. Server-only — `server-only` turns an accidental import
 * from a client component into a build error rather than a leaked principal.
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
 * `cache` deduplicates per request: the layout, the navigation and the page all
 * need the principal, and none of them should cost a second round-trip.
 */
export const resolveSession = cache(async (): Promise<ResolvedSession> => {
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

  const cookieStore = await cookies();

  const response = await apiRequest({
    method: 'GET',
    path: SESSION_ENDPOINT,
    // The API authenticates by cookie; forward the one the browser sent us.
    headers: forwardedSessionCookie(cookieStore),
  });

  const principal = SessionResponseSchema.parse(response).user;

  return { principal, checker: checkerForPrincipal(principal), isStubbed: false };
});

/**
 * The session cookie carries the `__Host-` prefix wherever `SESSION_COOKIE_SECURE`
 * is on — which is everywhere except local development, where Safari refuses a
 * `__Host-` cookie on plain-HTTP localhost and login would be impossible.
 *
 * The frontend does not read that flag, so it forwards whichever of the two names
 * the browser actually sent, preferring the secure spelling. Naming only the
 * development one would leave every deployed environment forwarding nothing, and
 * the symptom would be "signed in, then immediately signed out again".
 */
const SESSION_COOKIE_NAMES = [SESSION_COOKIE_NAME_SECURE, SESSION_COOKIE_NAME] as const;

function forwardedSessionCookie(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
): Record<string, string> {
  for (const name of SESSION_COOKIE_NAMES) {
    const value = cookieStore.get(name)?.value;

    if (value !== undefined) {
      return { cookie: `${name}=${value}` };
    }
  }

  return {};
}

/**
 * Server-side gate for a route. Returns the session when the principal holds the
 * permission and `null` when it does not, so the caller can render a real 403
 * state instead of a redirect that hides what happened.
 *
 * This is UX, not enforcement — the API refuses the same request regardless.
 */
export async function requirePermission(permission: Permission): Promise<ResolvedSession | null> {
  const session = await resolveSession();

  return session.checker.can(permission) ? session : null;
}

export async function requireAnyPermission(
  permissions: readonly Permission[],
): Promise<ResolvedSession | null> {
  const session = await resolveSession();

  return session.checker.canAny(permissions) ? session : null;
}

/**
 * For a server action: throws rather than returning `null`, because an action
 * that has already been invoked has no 403 page to render into.
 */
export async function assertPermission(permission: Permission): Promise<ResolvedSession> {
  const session = await resolveSession();

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
