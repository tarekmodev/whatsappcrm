import { TENANT_ROLES, isRoleWithin, type TenantRole } from '@whatsappcrm/contracts';

/**
 * The console's mirror of the three role-assignment invariants TAR-79 defined and
 * `apps/api/src/people/users.service.ts` enforces. Kept in one module so the invite
 * dialog and the edit dialog cannot drift from each other or from the API:
 *
 *   1. Assigning any role needs `user:set_role`. Without it, an invite may carry
 *      `agent` and nothing else — otherwise a supervisor holding `user:invite`
 *      could mint an admin.
 *   2. Nobody may grant a role above their own (`isRoleWithin`).
 *   3. Nobody may change their *own* role, admin included — so every escalation
 *      needs a second person, and an admin cannot lock themselves out.
 *
 * This is UX, not enforcement: the API refuses each of these regardless. It exists
 * so the console never offers a control whose use would be refused.
 */

export interface PeopleCaller {
  readonly userId: string;
  readonly role: TenantRole;
  /** Whether the caller holds `user:set_role`. */
  readonly canSetRole: boolean;
}

/**
 * Roles an invite may carry. A caller without `user:set_role` gets `agent` only —
 * invariant 1.
 */
export function invitableRoles(caller: PeopleCaller): readonly TenantRole[] {
  if (!caller.canSetRole) {
    return ['agent'];
  }

  return TENANT_ROLES.filter((role) => isRoleWithin(role, caller.role));
}

/**
 * Whether the role field should appear at all when editing `targetUserId`.
 * Invariant 3 is why a caller's own row is excluded even for an admin.
 */
export function canChangeRoleOf(caller: PeopleCaller, targetUserId: string): boolean {
  return caller.canSetRole && targetUserId !== caller.userId;
}

/** Roles that caller may assign to someone else — invariant 2. */
export function assignableRoles(caller: PeopleCaller): readonly TenantRole[] {
  return TENANT_ROLES.filter((role) => isRoleWithin(role, caller.role));
}
