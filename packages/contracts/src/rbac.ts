import { z } from 'zod';

/**
 * Role and permission vocabulary. TAR-22 owns the management UI; this file owns
 * the vocabulary that it and every guard in the API speak.
 *
 * **Guards check permissions, never roles.** `@RequirePermission('ticket:assign')`
 * survives TAR-22 adding a custom role; `if (role === 'admin')` scattered through
 * controllers does not. The role→permission table below is the only place a role
 * is ever interpreted.
 */

export const TENANT_ROLES = ['agent', 'supervisor', 'admin'] as const;

export const TenantRoleSchema = z.enum(TENANT_ROLES);
export type TenantRole = (typeof TENANT_ROLES)[number];

/**
 * Permission names are `<resource>:<action>`. An `_all` suffix widens a
 * permission from "the records assigned to me" to "every record in the tenant" —
 * that distinction is the whole difference between an agent and a supervisor, so
 * it is encoded in the permission rather than re-derived at each endpoint.
 */
export const PERMISSIONS = [
  'conversation:read',
  'conversation:read_all',
  'conversation:send',
  'conversation:assign',
  /**
   * Take a conversation **nobody holds** (TAR-186). Deliberately not part of
   * `conversation:assign`, which is the wider right to move a thread between
   * people — including off the colleague working it.
   *
   * The split is what lets every role hold this one. A shared inbox whose
   * arriving work can be read by every agent and taken by none is not a shared
   * inbox, and the alternative — granting agents `conversation:assign` — would
   * hand them re-assignment away from a colleague at the same time.
   *
   * Bounded to unassigned records by the route that checks it, not by the
   * permission: a permission cannot express "only while the row is still null",
   * so `ConversationCommandService.claim` compares and sets.
   */
  'conversation:claim',
  'conversation:note',

  'ticket:read',
  'ticket:read_all',
  'ticket:update',
  'ticket:assign',
  'ticket:close',

  'contact:read',
  'contact:write',
  'contact:delete',

  'user:read',
  'user:invite',
  'user:update',
  /**
   * Assigning a role is deliberately **not** part of `user:update` (TAR-79,
   * delta 1). Without the split, a supervisor holding `user:update` could
   * promote themselves, and one holding `user:invite` could mint an admin —
   * privilege escalation with no second person involved.
   *
   * Kept as a permission rather than an `if (caller.role !== 'admin')` inside
   * the users service, because a role interpretation outside `ROLE_PERMISSIONS`
   * is exactly what this file forbids, and because the console then reads it
   * off `principal.permissions` instead of hardcoding the same rule.
   */
  'user:set_role',
  'user:remove',

  'team:read',
  'team:write',

  'assignment_rule:read',
  'assignment_rule:write',

  'sla:read',
  'sla:write',

  'workflow:read',
  'workflow:write',

  'ai:read',
  'ai:write',

  'canned_response:read',
  'canned_response:write',

  'report:read',
  'report:read_all',

  'branding:write',
  'channel:manage',
  'tenant:settings',

  'billing:read',
  'billing:manage',
] as const;

export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = (typeof PERMISSIONS)[number];

const AGENT_PERMISSIONS = [
  'conversation:read',
  'conversation:send',
  'conversation:claim',
  'conversation:note',
  'ticket:read',
  'ticket:update',
  'ticket:close',
  'contact:read',
  'contact:write',
  'user:read',
  'team:read',
  'canned_response:read',
  'report:read',
] as const satisfies readonly Permission[];

const SUPERVISOR_PERMISSIONS = [
  ...AGENT_PERMISSIONS,
  'conversation:read_all',
  'conversation:assign',
  'ticket:read_all',
  'ticket:assign',
  'assignment_rule:read',
  'assignment_rule:write',
  'sla:read',
  'sla:write',
  'canned_response:write',
  'report:read_all',
  'team:write',
  'user:invite',
  /**
   * TAR-22 AC3 asks a supervisor to manage all agents in their tenant, and the
   * shipped table let them add someone to a team by editing the *team* but not
   * by editing the *person*, and never suspend a departing contractor.
   *
   * Safe only because `user:set_role` is separate: this grants name, status and
   * team membership, not promotion. `user:remove` stays admin-only — deletion is
   * irreversible and changes seat billing, while `status: 'suspended'` covers
   * "cut their access now" and is one click back.
   */
  'user:update',
] as const satisfies readonly Permission[];

/**
 * The single source of truth for what a role may do. TAR-22 may later replace
 * this constant with tenant-configurable rows; because guards already ask for
 * permissions rather than roles, that change touches this file and nothing else.
 */
export const ROLE_PERMISSIONS: Record<TenantRole, readonly Permission[]> = {
  agent: AGENT_PERMISSIONS,
  supervisor: SUPERVISOR_PERMISSIONS,
  admin: PERMISSIONS,
};

export function permissionsForRole(role: TenantRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: TenantRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Seniority, for the one rule permissions cannot express: **nobody may grant a
 * role above their own** (TAR-79, delta 3, invariant 2).
 *
 * Under the current table that is already implied — only an admin holds
 * `user:set_role`, and admin is the top of the order — so this is stated as an
 * invariant rather than discovered later. Adding a fourth role between
 * supervisor and admin must not silently open a path, and the ordering is the
 * thing that stops it.
 *
 * It is an ordering, not a second permission model: guards still check
 * permissions, and this is only ever consulted about the role being *written*.
 */
export const ROLE_SENIORITY: Record<TenantRole, number> = {
  agent: 0,
  supervisor: 1,
  admin: 2,
};

/** True when `role` is no more senior than `ceiling`. */
export function isRoleWithin(role: TenantRole, ceiling: TenantRole): boolean {
  return ROLE_SENIORITY[role] <= ROLE_SENIORITY[ceiling];
}
