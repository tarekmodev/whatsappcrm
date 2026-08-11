import {
  permissionsForRole,
  type Permission,
  type SessionPrincipal,
  type TenantRole,
} from '@whatsappcrm/contracts';

/**
 * Permission helpers. The UI asks "may this principal do X", never "is this
 * principal an admin" — the same rule TAR-39 fixed for the API guards, for the
 * same reason: a role added later touches `rbac.ts` and nothing else.
 *
 * These gates are UX only. The API enforces the identical permission on every
 * request; nothing here is a security boundary.
 */

export interface PermissionChecker {
  can: (permission: Permission) => boolean;
  canAny: (permissions: readonly Permission[]) => boolean;
  canAll: (permissions: readonly Permission[]) => boolean;
}

export function createPermissionChecker(granted: readonly Permission[]): PermissionChecker {
  const set = new Set<Permission>(granted);

  return {
    can: (permission) => set.has(permission),
    canAny: (permissions) => permissions.some((permission) => set.has(permission)),
    canAll: (permissions) => permissions.every((permission) => set.has(permission)),
  };
}

export function checkerForPrincipal(principal: SessionPrincipal): PermissionChecker {
  return createPermissionChecker(principal.permissions);
}

export function checkerForRole(role: TenantRole): PermissionChecker {
  return createPermissionChecker(permissionsForRole(role));
}

/**
 * The conversation scopes a principal may actually request. An agent without
 * `conversation:read_all` gets `assigned` only; offering them `all` would render
 * a tab that the API narrows behind their back.
 */
export function allowedConversationScopes(
  checker: PermissionChecker,
): readonly ('assigned' | 'unassigned' | 'all')[] {
  return checker.can('conversation:read_all')
    ? (['assigned', 'unassigned', 'all'] as const)
    : (['assigned'] as const);
}
