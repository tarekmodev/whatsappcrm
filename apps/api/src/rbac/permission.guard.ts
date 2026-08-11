import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@whatsappcrm/contracts';
import { ApiException } from '../common/errors/api.exception';
import { isPlatformRoute, isPublicRoute } from '../common/request-pipeline/route-access';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { REQUIRED_PERMISSIONS } from './require-permission.decorator';

/**
 * Enforces the permission matrix (TAR-39, request pipeline slot 5).
 *
 * Installed globally by `RequestPipelineModule` since TAR-58, which is what
 * turns the deny-by-default below from a property of the controllers that
 * remembered the guard into a property of the application. It skips the same two
 * decorators `PrincipalGuard` does — neither leaves a caller behind, and a
 * permission check with no caller has nothing to check.
 *
 * Two properties are the whole design:
 *
 *   * **Deny by default.** A route behind this guard with no
 *     `@RequirePermission` is refused, not admitted. The alternative — treating
 *     an absent decorator as "public" — makes every future route one forgotten
 *     line away from being open, and that line is invisible in review because it
 *     is not there. A route that genuinely needs no permission says so with
 *     `@AnyPrincipal()`, which is a decision somebody wrote down.
 *   * **It reads `principal.permissions`, never `principal.role`.** The array is
 *     materialised from the role by `permissionsForRole` when the principal is
 *     resolved, so there is exactly one interpretation of a role in the system
 *     and it lives in `rbac.ts`.
 *
 * Route metadata wins over controller metadata, so a controller can state the
 * permission its routes share and one route can narrow it.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (isPlatformRoute(this.reflector, context) || isPublicRoute(this.reflector, context)) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<readonly Permission[] | undefined>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );

    if (required === undefined) {
      throw new Error(
        `${context.getClass().name}.${context.getHandler().name} is behind PermissionGuard with ` +
          'no @RequirePermission. Declare the permission it needs, or @AnyPrincipal() if it needs none.',
      );
    }

    const principal = this.tenantContext.principal;

    if (principal === null) {
      throw new Error(
        'PermissionGuard ran with no principal in scope. It must be declared after PrincipalGuard.',
      );
    }

    const missing = required.filter((permission) => !principal.permissions.includes(permission));

    if (missing.length > 0) {
      // `forbidden`, not `not_found`: the principal can see that this operation
      // exists — it is their own tenant's people list — they simply may not
      // perform it. `not_found` is reserved for a *record* they may not see,
      // where a 403 would confirm it exists.
      throw new ApiException(
        'forbidden',
        `This account does not have permission to ${describe(missing)}.`,
      );
    }

    return true;
  }
}

/**
 * The permission names themselves, which are published in the contract and in
 * the console's own permission checker. Naming what was missing is what lets a
 * caller fix their request instead of guessing; it discloses nothing they could
 * not read in the API reference.
 */
function describe(missing: readonly Permission[]): string {
  return missing.join(' and ');
}
