import {
  permissionsForRole,
  type Permission,
  type SessionPrincipal,
  type TenantRole,
} from '@whatsappcrm/contracts';
import type { InboxScope, TicketScope } from '@/lib/routes';

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
 * True when the API will return less than the scope the caller named.
 *
 * Every role may request every scope — `INBOX_SCOPES` in `lib/routes.ts` says
 * so, and explains why the agent cap that used to live here was removed. Only
 * `all` can be narrowed: for a principal without `conversation:read_all` it
 * means "mine ∪ my teams' ∪ unclaimed" rather than the whole tenant, and the API
 * narrows rather than rejecting so a supervisor's shared link still renders.
 * Saying so is what stops an agent wondering why the list looks short.
 */
export function isConversationScopeNarrowed(
  checker: PermissionChecker,
  scope: InboxScope,
): boolean {
  return scope === 'all' && !checker.can('conversation:read_all');
}

/**
 * The same question for the ticket queue, against the ticket permission.
 *
 * Deliberately a second function rather than a parameterised one: the two rules
 * are not the same rule. A conversation's `all` narrows to "mine ∪ my teams' ∪
 * unclaimed", because an unclaimed thread is visible to every agent. A ticket's
 * narrows to "mine ∪ my teams'" only — an unassigned ticket is triaged work, not
 * a shared pool — so a caller reading one of these must not be able to assume it
 * means what the other one does.
 */
export function isTicketScopeNarrowed(checker: PermissionChecker, scope: TicketScope): boolean {
  return scope === 'all' && !checker.can('ticket:read_all');
}
