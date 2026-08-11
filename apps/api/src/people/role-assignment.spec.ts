import { permissionsForRole, type SessionPrincipal, type TenantRole } from '@whatsappcrm/contracts';
import { RoleAssignmentNotPermittedError, RoleEscalationError } from './people.errors';
import { assertRoleAssignable } from './role-assignment';

/**
 * The escalation rule both the invite path (TAR-55) and `PATCH /users/{id}`
 * (TAR-22) run, tested once against the function they share.
 *
 * The case that matters is the third one: a supervisor holds `user:invite`, and
 * `InviteCreateInputSchema.role` accepts any role, so without this rule they
 * could mint an admin account and have it administer billing and the WhatsApp
 * credentials.
 */

function principalFor(role: TenantRole): SessionPrincipal {
  return {
    userId: '0192f0ff-0000-7000-8000-00000000a001',
    tenantId: '0192f0ff-0000-7000-8000-0000000000b1',
    email: `${role}@example.invalid`,
    displayName: role,
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: '0192f0ff-0000-7000-8000-0000000000ff',
    expiresAt: '2026-12-31T23:59:59.000Z',
  };
}

describe('assertRoleAssignable', () => {
  it('lets an admin assign any of the three roles', () => {
    const admin = principalFor('admin');

    for (const role of ['agent', 'supervisor', 'admin'] as const) {
      expect(() => {
        assertRoleAssignable(role, admin);
      }).not.toThrow();
    }
  });

  it('lets a supervisor assign the agent role', () => {
    expect(() => {
      assertRoleAssignable('agent', principalFor('supervisor'));
    }).not.toThrow();
  });

  it('refuses a supervisor assigning supervisor or admin', () => {
    const supervisor = principalFor('supervisor');

    for (const role of ['supervisor', 'admin'] as const) {
      expect(() => {
        assertRoleAssignable(role, supervisor);
      }).toThrow(RoleAssignmentNotPermittedError);
    }
  });

  it('refuses a caller granting a role above their own, permission or not', () => {
    // A hand-built principal: nobody holds `user:set_role` without being an
    // admin today, and this asserts the second rule survives that changing.
    const supervisor: SessionPrincipal = {
      ...principalFor('supervisor'),
      permissions: [...permissionsForRole('supervisor'), 'user:set_role'],
    };

    expect(() => {
      assertRoleAssignable('admin', supervisor);
    }).toThrow(RoleEscalationError);
    expect(() => {
      assertRoleAssignable('agent', supervisor);
    }).not.toThrow();
  });
});
