import { isRoleWithin, type SessionPrincipal, type TenantRole } from '@whatsappcrm/contracts';
import { RoleAssignmentNotPermittedError, RoleEscalationError } from './people.errors';

/**
 * What role a caller may hand to somebody else (TAR-79, delta 1).
 *
 * Two rules, in this order:
 *
 *   * **`user:set_role` or agents only.** A caller holding `user:invite` but not
 *     `user:set_role` may invite an `agent` and nothing else. That single rule is
 *     what closes the escalation path the shipped contract leaves open —
 *     `InviteCreateInputSchema.role` accepts any role, so without it a supervisor
 *     could mint an admin, never accept it, and have that account administer
 *     billing and the WhatsApp credentials.
 *   * **Never above your own.** Even with the permission, an admin is the ceiling
 *     for an admin.
 *
 * Lives here rather than inside one service because two paths assign a role —
 * `POST /users/invites` (TAR-55) and `PATCH /users/{id}` (TAR-22) — and a
 * security rule implemented twice is a security rule that will one day be
 * implemented once.
 */
export function assertRoleAssignable(role: TenantRole, principal: SessionPrincipal): void {
  if (!principal.permissions.includes('user:set_role')) {
    if (role !== 'agent') {
      throw new RoleAssignmentNotPermittedError(role);
    }
    return;
  }

  if (!isRoleWithin(role, principal.role)) {
    throw new RoleEscalationError(role, principal.role);
  }
}
