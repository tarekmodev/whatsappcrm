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
