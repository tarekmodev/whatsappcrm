import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { Permission } from '@whatsappcrm/contracts';

export const REQUIRED_PERMISSIONS = 'rbac:required-permissions';

/**
 * States what a route needs, in the vocabulary of `rbac.ts`.
 *
 * ```ts
 * @RequirePermission('user:update')
 * ```
 *
 * A permission, never a role. `if (role === 'admin')` scattered through
 * controllers has to be found and edited every time the matrix moves; this does
 * not, and `ROLE_PERMISSIONS` stays the only place in the system where a role is
 * interpreted. Several permissions mean **all** of them are required, which is
 * what the one route that needs two — a `PATCH /users/{id}` carrying `role` —
 * actually asks for.
 */
export const RequirePermission = (...permissions: readonly Permission[]): CustomDecorator<string> =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/**
 * For the routes that genuinely need no permission beyond being signed in —
 * `PATCH /users/me/availability`, where the resource *is* the caller.
 *
 * Spelled out rather than left implicit. `PermissionGuard` refuses a route with
 * no metadata at all, so "this one needs nothing" has to be a decision somebody
 * wrote and a reviewer can see, instead of a missing line nobody notices.
 */
export const AnyPrincipal = (): CustomDecorator<string> => SetMetadata(REQUIRED_PERMISSIONS, []);
