import { SetMetadata, type CustomDecorator, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

/**
 * How a route opts out of the globally installed pipeline (TAR-58).
 *
 * The pipeline is on for every route, so a controller does not choose to be
 * protected — it chooses to be *less* protected, out loud, in one of exactly two
 * ways. That inversion is the whole point of the story: a new endpoint that says
 * nothing is closed, and a route that is open is a decision a reviewer can see
 * in the diff.
 *
 * Both are read with `getAllAndOverride([handler, class])`, so a controller can
 * state the posture its routes share and a single route can restate it.
 */

export const PUBLIC_ROUTE = 'pipeline:public-route';
export const PLATFORM_ROUTE = 'pipeline:platform-route';

/**
 * No session required — but still inside a tenant.
 *
 * `HostTenantGuard` keeps running, which is the property worth protecting: login
 * and password reset resolve their tenant from the request host, which is why
 * there is no tenant field anywhere in those contracts for a caller to choose.
 * What is skipped is `PrincipalGuard` and `PermissionGuard` (TAR-39's pipeline
 * stages 3 and 5), because there is nobody to resolve yet.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(PUBLIC_ROUTE, true);

/**
 * Not served inside a tenant at all: `/api/health`, Meta's webhook, and
 * `/api/v1/admin/*` (TAR-39, "`/api/v1/admin/*` skips stages 2–6").
 *
 * Skips tenant resolution as well as the session, because there is no tenant to
 * resolve — the liveness probe arrives at a container address, Meta posts to the
 * platform host, and the platform operator is not a user inside any tenant.
 *
 * ⚠️ It is **not** a synonym for "unauthenticated". Every route wearing it
 * carries its own authentication instead: `PlatformAdminGuard`'s timing-safe
 * bearer token on the admin surface, and the HMAC over the raw body on the
 * webhook. A route that needs neither — health — is deliberately open and says
 * so in its own comment. Adding this decorator to a tenant-facing route removes
 * every isolation guarantee the platform has, so it is the one line in this
 * codebase worth reading twice in review.
 */
export const PlatformRoute = (): CustomDecorator<string> => SetMetadata(PLATFORM_ROUTE, true);

export function isPublicRoute(reflector: Reflector, context: ExecutionContext): boolean {
  return readFlag(reflector, context, PUBLIC_ROUTE);
}

export function isPlatformRoute(reflector: Reflector, context: ExecutionContext): boolean {
  return readFlag(reflector, context, PLATFORM_ROUTE);
}

/**
 * Absent metadata reads as `false` — the closed answer. A guard asking "may this
 * route skip me" must never get "yes" from a route that said nothing.
 */
function readFlag(reflector: Reflector, context: ExecutionContext, key: string): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(key, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}
